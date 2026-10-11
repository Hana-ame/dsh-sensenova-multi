/**
 * Failure vocabulary for the multi-key rotation layer.
 *
 * One code set, one retryable set — the rotation loop decides everything from
 * `retryable`, so a new failure kind is one line here and never a new branch in
 * `stream()`. The split follows the rule already proven on the free lane: only
 * failures that a *different key* can plausibly answer differently are
 * retryable. A request defect (400) replays identically into every key, so it
 * stops the loop instead of burning the quota of the whole pool.
 *
 * @module src/errors.js
 */

export const CODE = {
  /** Quota or rate limit: another key may still have budget left. */
  rateLimit: 'RATE_LIMIT',
  /** The deadline expired before a first byte or a full JSON answer. */
  timeout: 'TIMEOUT',
  /** An HTTP 2xx with no assistant content. */
  empty: 'EMPTY_RESPONSE',
  /** DNS, TCP or TLS refusal, a reset, a proxy that dropped the hop. */
  transport: 'TRANSPORT',
  /** Upstream 5xx: the endpoint itself is broken for this key. */
  server: 'SERVER',
  /** The request is wrong. Replaying it at another key reproduces the refusal. */
  client: 'CLIENT_ERROR',
  /** The endpoint refuses the credential (401). */
  credential: 'CREDENTIAL',
  /** The endpoint refuses the credential's scope (403). */
  forbidden: 'FORBIDDEN',
  /** The key table is empty or the endpoint is unset. Never retryable. */
  config: 'CONFIG',
  /** The caller walked away. Not a key failure at all. */
  aborted: 'ABORTED',
}

/**
 * Failures worth retrying with the SAME key (with backoff).
 *
 * The new semantics are session-level key selection: a session is bound to
 * one key for its entire lifetime. These failures are transient and may
 * succeed on retry with the same key.
 *
 * `CLIENT_ERROR`, `CREDENTIAL`, `FORBIDDEN`, `CONFIG` and `ABORTED` are
 * deliberately absent — the key is invalid, the request is wrong, or the
 * caller walked away. Retrying the same key would not help.
 */
const RETRYABLE = new Set([
  CODE.rateLimit,
  CODE.timeout,
  CODE.empty,
  CODE.transport,
  CODE.server,
])

export function isRetryable(code) {
  return RETRYABLE.has(code)
}

/**
 * Map an HTTP status onto a failure code, letting the body override the status
 * where the body is more specific: a gateway that answers 200 with a
 * `rate_limit` error object is a quota event, not a healthy answer.
 *
 * @param {number} status - HTTP status code.
 * @param {string} [text] - response body text.
 * @returns {string} failure code.
 */
export function classifyHttpStatus(status, text = '') {
  const flat = String(text ?? '').toLowerCase()
  // 429 — rate limit; another key may have budget left.
  if (status === 429 || /rate.?limit|too many requests|usage limit|quota|rate.?limit/i.test(flat)) {
    return CODE.rateLimit
  }
  // 401 — invalid or expired credential; try the next key.
  if (status === 401 || /invalid api.?key|authentication|unauthorized|access denied/i.test(flat)) {
    return CODE.credential
  }
  // 403 — credential lacks scope; try the next key.
  if (status === 403 || /forbidden|permission denied|insufficient/i.test(flat)) {
    return CODE.forbidden
  }
  // 5xx — endpoint broken for this key.
  if (status >= 500) return CODE.server
  // 4xx — request defect; replaying into another key reproduces it.
  if (status >= 400) return CODE.client
  // A 2xx with an error envelope falls through to SERVER: the endpoint
  // answered, but not with an answer. Worth a key switch.
  return CODE.server
}

/**
 * Turn a rejected `fetch` into a code, keeping caller aborts apart.
 *
 * @param {unknown} error - the thrown value.
 * @param {{ callerSignal?: AbortSignal, deadlineSignal?: AbortSignal }} [ctx]
 * @returns {string} failure code.
 */
export function classifyFetchError(error, ctx = {}) {
  if (ctx.callerSignal?.aborted === true) return CODE.aborted
  if (ctx.deadlineSignal?.aborted === true) return CODE.timeout
  const name = String(error?.name ?? '')
  if (name === 'AbortError' || name === 'TimeoutError') return CODE.timeout
  return CODE.transport
}

/**
 * Pull a short human-readable reason out of an upstream error body.
 *
 * @param {string} text - response body.
 * @param {number} [limit] - max characters.
 * @returns {string}
 */
export function summarizeErrorBody(text, limit = 300) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return ''
  try {
    const json = JSON.parse(trimmed)
    const message = json?.error?.message ?? (typeof json?.error === 'string' ? json.error : undefined) ?? json?.message
    if (typeof message === 'string' && message !== '') return cut(message, limit)
  } catch { /* not JSON */ }
  return cut(trimmed, limit)
}

/** Mask a key for logging: show the first 6 and last 4 characters. */
export function maskKey(key) {
  const s = String(key ?? '')
  if (s.length <= 10) return s.length > 0 ? `${s.slice(0, 2)}…${s.slice(-2)}` : '(empty)'
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}

function cut(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}
