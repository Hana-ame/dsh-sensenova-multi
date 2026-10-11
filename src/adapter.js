/**
 * The SenseNova multi-key adapter — session-level key selection.
 *
 * Each session binds to one key at creation time via the model name:
 *   `senseNova-6.8-flash-lite@k1` → model `senseNova-6.8-flash-lite`, key alias `k1`
 *   `senseNova-6.8-flash-lite`    → model `senseNova-6.8-flash-lite`, default key `k1`
 *
 * The session uses that single key for its entire lifetime. On a 429 (rate
 * limit) the adapter retries the SAME key with backoff — it does NOT switch
 * to another key. This is load distribution, not failover: each session
 * should use a different key so that concurrent sessions don't share a
 * single key's quota.
 *
 * The seven adapter methods:
 *   providerInfo       — display metadata for one route
 *   providerRetryPolicy — maxRetries=0; retries are internal (same key)
 *   imageRequestPricing — undefined; endpoint publishes no per-image price
 *   listModels          — models × key aliases (one entry per key per model)
 *   resolveModel        — parse @key suffix, return model metadata
 *   prepareCall         — bind model metadata + a one-shot stream closure
 *   stream              — translate, dispatch with single key, retry same key on 429
 *
 * @module src/adapter.js
 */

import {
  ROUTE_LABELS,
  ROUTE_PRIMARY,
  DEFAULT_MODEL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_KEY_ALIAS,
  catalogRows,
  resolveModelInfo,
  findModel,
} from './catalog.js'
import { createKeyPool, maskKey } from './keys.js'
import { dispatch as dispatchUpstream, toChatBody, UpstreamError, DEFAULT_TIMEOUT_MS } from './upstream.js'
import { parseSseStream, jsonToChunks } from './stream.js'
import { CODE } from './errors.js'

/** Default number of retries for the same key on a transient failure. */
const DEFAULT_MAX_RETRIES = 2

/** Base delay for exponential backoff (ms). */
const RETRY_BASE_DELAY_MS = 1_000

/**
 * @param {object} dependencies
 * @param {() => object} dependencies.state - returns the current settings snapshot.
 * @param {(message: string) => void} [dependencies.log]
 * @param {Function} [dependencies.fetchImpl] - injectable transport.
 * @param {(ms: number) => Promise<void>} [dependencies.sleep] - injectable sleep for tests.
 */
export class SensenovaAdapter {
  constructor(dependencies) {
    this.deps = dependencies
    this._pool = null
    this._poolKeys = null
  }

  /** Ensure the key pool is built from the current settings. */
  _ensurePool() {
    const settings = this.deps.state()
    const keys = settings.keys ?? []
    const keyFingerprint = keys.join('\u0000')
    if (this._pool === null || this._poolKeys !== keyFingerprint) {
      this._pool = createKeyPool({ keys })
      this._poolKeys = keyFingerprint
    }
    return this._pool
  }

  /** @returns {{ size: number, aliases: string[], masked: string[] }} */
  _poolStatus() {
    const pool = this._ensurePool()
    const stats = pool.stats()
    return {
      size: stats.length,
      aliases: stats.map(s => s.alias),
      masked: stats.map(s => s.masked),
    }
  }

  /** Injectable sleep for backoff. Defaults to setTimeout. */
  async _sleep(ms) {
    if (this.deps.sleep) return this.deps.sleep(ms)
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  // ── 1. providerInfo ──────────────────────────────────────────────────────

  /**
   * @param {string} provider - a route passed to registerAdapter().
   * @returns {{ id: string, name: string }}
   */
  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABELS[provider] ?? provider }
  }

  // ── 2. providerRetryPolicy ────────────────────────────────────────────────

  /**
   * Return a resolved retry policy.
   *
   * maxRetries=0 because the adapter handles retries internally (same key
   * with backoff). The harness retry plugin should not re-attempt the whole
   * turn — that would re-enter the adapter's own retry loop.
   *
   * @param {string} _provider
   * @returns {object} a resolved normal retry policy.
   */
  providerRetryPolicy(_provider) {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: Object.freeze([]),
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    })
  }

  // ── 3. imageRequestPricing ────────────────────────────────────────────────

  /**
   * Nothing declared: the endpoint publishes no per-image price.
   *
   * @param {string} _provider
   * @param {string} _model
   * @returns {undefined}
   */
  imageRequestPricing(_provider, _model) {
    return undefined
  }

  // ── 4. listModels ─────────────────────────────────────────────────────────

  /**
   * List models, one entry per key alias.
   *
   * When the pool has keys, each model is listed as `{model-id}@{alias}`
   * so the model picker shows one entry per key. A session that picks
   * `senseNova-6.8-flash-lite@k2` is bound to key `k2` for its lifetime.
   *
   * When the pool is empty, lists models without key suffixes (the adapter
   * will fail at dispatch time with a CONFIG error).
   *
   * @param {string} provider
   * @returns {Promise<readonly object[]>}
   */
  async listModels(provider) {
    const pool = this._ensurePool()
    const aliases = pool.size > 0 ? pool.keyAliases() : []
    return catalogRows(provider ?? ROUTE_PRIMARY, aliases)
  }

  // ── 5. resolveModel ───────────────────────────────────────────────────────

  /**
   * Resolve model metadata. Parses the `@key` suffix from the model name.
   *
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [_signal]
   * @returns {Promise<object>}
   */
  async resolveModel(provider, model, _signal) {
    const resolved = resolveModelInfo(provider ?? ROUTE_PRIMARY, model)
    if (resolved !== null) return resolved

    // Unknown model: return a sensible default so the router can still proceed.
    const { modelId } = parseModelKeyLocal(model)
    const row = findModel(modelId)
    return {
      provider: provider ?? ROUTE_PRIMARY,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: row?.maxOutput ?? DEFAULT_MAX_TOKENS,
    }
  }

  // ── 6. prepareCall ────────────────────────────────────────────────────────

  /**
   * Bind model metadata and the dispatch closure to one state snapshot, so a
   * settings change arriving mid-turn cannot mix one generation's capacities
   * with another's key table.
   *
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   * @returns {Promise<{model: object, stream: (options: object) => AsyncIterable<object>}>}
   */
  async prepareCall(provider, model, signal) {
    const info = await this.resolveModel(provider, model, signal)
    return {
      model: info,
      stream: options => this.stream(options),
    }
  }

  // ── 7. stream ─────────────────────────────────────────────────────────────

  /**
   * One turn: translate DSH options to an OpenAI body, dispatch with the
   * session's bound key, and yield DSH StreamChunks.
   *
   * Key selection: the model name may contain an `@alias` suffix that
   * selects the key. Without a suffix, the first key in the pool is used.
   * The key is fixed for the entire turn — the adapter does NOT switch keys
   * on failure.
   *
   * Retry: on a transient failure (429, 5xx, timeout, transport), the adapter
   * retries the SAME key with exponential backoff. On a permanent failure
   * (400, 401, 403), it yields an error finish immediately.
   *
   * @param {object} options - GenerateOptions.
   * @returns {AsyncIterable<object>} DSH StreamChunks.
   */
  async *stream(options) {
    const settings = this.deps.state()
    const url = `${settings.endpoint ?? ''}${settings.path ?? '/v1/chat/completions'}`
    const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxRetries = settings.maxRetries ?? DEFAULT_MAX_RETRIES
    const pool = this._ensurePool()

    // No keys: fail fast.
    if (pool.size === 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: CODE.config,
            message: 'sensenova-multi: no API keys configured — add keys to settings.json',
          },
        },
      }
      return
    }

    // Parse the key alias from the model name.
    const { modelId, alias } = parseModelKeyLocal(options.model)
    const key = pool.resolveKey(alias)

    if (key === null) {
      const available = pool.keyAliases().join(', ')
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: CODE.config,
            message: `sensenova-multi: unknown key alias "${alias}" — available: ${available}`,
          },
        },
      }
      return
    }

    const keyAlias = alias ?? pool.resolveAlias(key) ?? DEFAULT_KEY_ALIAS
    const keyMasked = maskKey(key)

    // Translate DSH options to OpenAI chat body (with the resolved model id).
    const body = toChatBody({ ...options, model: modelId })
    const signal = options.signal ?? undefined

    // Retry loop: same key, exponential backoff on transient failures.
    let attempt = 0
    let lastError = null

    while (attempt <= maxRetries) {
      attempt += 1
      try {
        const result = await dispatchUpstream({
          url,
          key,
          body,
          signal,
          timeoutMs,
          keyIndex: pool.stats().findIndex(s => s.alias === keyAlias),
          keyMasked,
          fetchImpl: this.deps.fetchImpl,
        })

        // Success.
        this.deps.log?.(`sensenova: ${keyAlias} (${keyMasked}) answered${attempt > 1 ? ` after ${attempt - 1} retry` : ''}`)

        if (result.stream && result.body) {
          yield* parseSseStream(result.body, { signal })
        } else if (result.json) {
          yield* jsonToChunks(result.json)
        } else {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: CODE.empty, message: 'upstream returned no body' },
            },
          }
        }
        return // success: done
      } catch (error) {
        lastError = error
        if (!(error instanceof UpstreamError)) {
          // Unexpected error: treat as transport failure.
          lastError = new UpstreamError(String(error?.message ?? error), CODE.transport, {
            retryable: true,
            keyMasked,
          })
        }

        const { code, message, statusCode } = lastError

        // Caller cancelled: not a key failure, don't retry.
        if (code === CODE.aborted) {
          yield {
            type: 'finish',
            reason: {
              kind: 'aborted',
              failure: { code: CODE.aborted, message: 'caller cancelled' },
            },
          }
          return
        }

        // Non-retryable: the request is wrong or the key is invalid.
        if (!lastError.retryable) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                code,
                message: `sensenova: key ${keyAlias} (${keyMasked}) rejected: ${message}`,
                status: statusCode,
              },
            },
          }
          return
        }

        // Retryable but out of retries: yield the last error.
        if (attempt > maxRetries) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                code,
                message: `sensenova: key ${keyAlias} (${keyMasked}) failed after ${maxRetries} retries: ${message}`,
                status: statusCode,
              },
            },
          }
          return
        }

        // Retryable and still have retries left: backoff and retry same key.
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
        this.deps.log?.(`sensenova: ${keyAlias} (${keyMasked}) failed (${code}${statusCode ? ` HTTP ${statusCode}` : ''}): ${message} — retry ${attempt}/${maxRetries} in ${delay}ms`)
        await this._sleep(delay)
      }
    }

    // Should be unreachable, but just in case.
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: CODE.server,
          message: `sensenova: key ${keyAlias} (${keyMasked}) exhausted retries`,
        },
      },
    }
  }
}

/** Parse a model name that may contain an `@key` suffix (local helper). */
function parseModelKeyLocal(model) {
  const s = String(model ?? '')
  const atIndex = s.lastIndexOf('@')
  if (atIndex < 0) return { modelId: s, alias: null }
  const modelId = s.slice(0, atIndex)
  const alias = s.slice(atIndex + 1)
  return { modelId, alias: alias !== '' ? alias : null }
}
