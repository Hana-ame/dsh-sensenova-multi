/**
 * SenseNova Multi-Key — plugin entry (Host half).
 *
 * Wiring: one adapter instance, two provider routes (sensenova and
 * sensenova-multi), a settings-backed key pool behind them, and the OpenAI
 * compatible forward listener (when enabled).
 *
 * The plugin's job is to register the adapter with the harness and let the
 * multi-key rotation do its work. Every harness facility is reached through
 * `ctx`, and only the one the plugin cannot exist without is declared in
 * `inject`, so a headless composition degrades a feature rather than failing
 * the plugin.
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SensenovaAdapter } from './src/adapter.js'
import { ROUTE_PRIMARY, ROUTE_MULTI, ROUTE_LABELS } from './src/catalog.js'
import { loadSettings, validateSettings } from './src/settings.js'
// Forward listener logic is inline in apply(); forward.js is available
// for external consumers that want to start a standalone server.

export const name = 'sensenova-multi'

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))

function readPackageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

export const version = readPackageVersion()

/**
 * `llm` is what the plugin exists for, so it is the only hard requirement.
 *
 * `webServer` is reached through a nested `ctx.inject` fiber so a headless
 * composition can still serve models without a settings page.
 */
export const inject = ['llm']

/**
 * @param {object} ctx - the cordis context.
 * @param {object} [bundleConfig] - configuration from the bundle.
 * @returns {void}
 */
export function apply(ctx, bundleConfig = {}) {
  const logger = ctx.logger ?? { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, log: () => {} }

  // Load settings once at apply time, but keep a mutable snapshot so a
  // settings change can be picked up without re-registering.
  const settings = { ...loadSettings() }

  /**
   * The mutable state the adapter reads through `state()`.
   * A settings reload mutates this object in place.
   */
  const state = { settings }

  /** Validate settings and log problems. */
  function checkSettings() {
    const problems = validateSettings(state.settings)
    if (problems.length > 0) {
      logger.warn(`sensenova-multi: settings problems: ${problems.join('; ')}`)
    }
  }
  checkSettings()

  const adapter = new SensenovaAdapter({
    state: () => state.settings,
    log: msg => logger.info(msg),
  })

  // Register the adapter under both routes.
  const registration = ctx.llm.registerAdapter([ROUTE_PRIMARY, ROUTE_MULTI], adapter)
  logger.info(`sensenova-multi: registered adapter for routes: ${ROUTE_PRIMARY}, ${ROUTE_MULTI}`)

  // Reload settings on a timer (if available) so a settings.json edit is picked
  // up without a full restart. The adapter reads through state(), so mutating
  // state.settings in place is sufficient.
  let reloadTimer = null
  if (typeof ctx.timer?.interval === 'function') {
    reloadTimer = ctx.timer.interval(() => {
      try {
        const fresh = loadSettings()
        const changed = JSON.stringify(fresh) !== JSON.stringify(state.settings)
        if (changed) {
          Object.assign(state.settings, fresh)
          checkSettings()
          logger.info('sensenova-multi: settings reloaded')
        }
      } catch (error) {
        logger.warn(`sensenova-multi: settings reload failed: ${error?.message ?? error}`)
      }
    }, 15_000)
  } else if (typeof ctx.get('timer')?.interval === 'function') {
    reloadTimer = ctx.get('timer').interval(() => {
      try {
        const fresh = loadSettings()
        const changed = JSON.stringify(fresh) !== JSON.stringify(state.settings)
        if (changed) {
          Object.assign(state.settings, fresh)
          checkSettings()
          logger.info('sensenova-multi: settings reloaded')
        }
      } catch (error) {
        logger.warn(`sensenova-multi: settings reload failed: ${error?.message ?? error}`)
      }
    }, 15_000)
  }

  // Forward listener (OpenAI-compatible proxy): register a web server route.
  if (state.settings.listen === true && ctx.get('webServer') !== undefined) {
    ctx.get('webServer').register({
      kind: 'route',
      path: '/v1/chat/completions',
      method: 'POST',
      handler: async (req, res) => {
        const body = await readRequestBody(req)
        const adapterOpts = {
          provider: ROUTE_PRIMARY,
          model: body.model ?? state.settings.defaultModel ?? 'senseNova-6.8-flash-lite',
          messages: body.messages ?? [],
          stream: body.stream === true,
          temperature: body.temperature,
          maxTokens: body.max_tokens ?? body.maxTokens,
          stop: body.stop,
          tools: body.tools,
        }
        try {
          const prepared = await adapter.prepareCall(adapterOpts.provider, adapterOpts.model)
          const iter = prepared.stream(adapterOpts)
          let firstChunk = null
          const collected = []
          for await (const chunk of iter) {
            collected.push(chunk)
            if (!firstChunk) firstChunk = chunk
          }
          // Convert chunks back to OpenAI format.
          const answer = chunksFromDsh(collected)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(answer))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
        }
      },
    })
    logger.info('sensenova-multi: forward listener registered at /v1/chat/completions')
  }

  // Clean up on dispose.
  return {
    [Symbol.dispose]: () => {
      registration()
      if (reloadTimer && typeof reloadTimer === 'function') reloadTimer()
      else if (reloadTimer && typeof reloadTimer[Symbol.dispose] === 'function') reloadTimer[Symbol.dispose]()
      logger.info('sensenova-multi: disposed')
    },
  }
}

/** Read a request body as JSON. */
async function readRequestBody(req) {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

/** Convert DSH chunks back to an OpenAI response shape. */
function chunksFromDsh(chunks) {
  const textParts = []
  const toolCalls = []
  let usage = null

  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') {
      textParts.push(chunk.text)
    } else if (chunk.type === 'tool-call-delta') {
      toolCalls.push(chunk)
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'finish') {
      if (chunk.reason?.kind === 'error') {
        throw new Error(chunk.reason.failure?.message ?? 'upstream error')
      }
    }
  }

  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'senseNova-6.8-flash-lite',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: textParts.join(''),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsDelta },
        })) } : {}),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    ...(usage ? { usage: usage } : {}),
  }
}
