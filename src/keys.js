/**
 * The key pool: session-level key selection for load distribution.
 *
 * Each key in the pool gets a stable alias (`k1`, `k2`, …) based on its
 * position in the settings array. A session picks one alias at creation time
 * and uses that single key for its entire lifetime — not because a request
 * failed, but because different sessions should distribute load across keys
 * so that no single key's quota is exhausted by concurrent sessions.
 *
 * This is NOT automatic rotation: the adapter does not switch keys on 429 or
 * 401. A 429 means "this key is rate-limited; retry the same key with backoff".
 * A 401 means "this key is invalid; fail, don't try another key — the session
 * is bound to this key".
 *
 * The pool is stateless: it stores the key list, exposes aliases, and
 * provides a round-robin allocator (`nextKeyAlias`) that suggests which key
 * to assign to a new session. The suggestion is advisory — the decision is
 * made by the caller (session_create, GUI, or external tool) at setup time.
 *
 * @module src/keys.js
 */

/** Alias prefix for positional key aliases. */
const ALIAS_PREFIX = 'k'

/** Mask a key for logging: show the first 6 and last 4 characters. */
export function maskKey(key) {
  const s = String(key ?? '')
  if (s.length === 0) return '(empty)'
  if (s.length <= 10) return `${s.slice(0, 2)}…${s.slice(-2)}`
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}

/**
 * Generate the positional alias for a key at index `i` in the pool.
 *
 * @param {number} i - zero-based index.
 * @returns {string} alias like `k1`, `k2`, etc.
 */
export function aliasForIndex(i) {
  return `${ALIAS_PREFIX}${i + 1}`
}

/**
 * Parse an alias like `k1` back to its zero-based index.
 *
 * @param {string} alias - the alias string.
 * @returns {number | null} the zero-based index, or null if not a valid alias.
 */
export function indexForAlias(alias) {
  const s = String(alias ?? '').toLowerCase()
  if (s.length < 2 || s[0] !== ALIAS_PREFIX[0]) return null
  const n = Number(s.slice(1))
  if (!Number.isInteger(n) || n < 1) return null
  return n - 1
}

/**
 * Create a key pool for session-level key selection.
 *
 * @param {object} args
 * @param {string[]} [args.keys] - the key pool, in priority order.
 * @returns {{
 *   size: number,
 *   resolveKey: (alias: string | null | undefined) => string | null,
 *   resolveAlias: (key: string) => string | null,
 *   keyAliases: () => string[],
 *   nextKeyAlias: () => string | null,
 *   parseModelKey: (model: string) => {modelId: string, alias: string | null},
 *   stats: () => Array<{index: number, alias: string, masked: string}>,
 * }}
 */
export function createKeyPool({ keys = [] } = {}) {
  const list = [...new Set(keys.map(k => String(k).trim()).filter(k => k !== ''))]

  /** Map: alias → actual key value. */
  const aliasMap = new Map()
  /** Map: actual key → alias. */
  const keyToAlias = new Map()
  for (let i = 0; i < list.length; i++) {
    const alias = aliasForIndex(i)
    aliasMap.set(alias, list[i])
    keyToAlias.set(list[i], alias)
  }

  /** Round-robin cursor for the `nextKeyAlias` suggestion. */
  let cursor = 0

  /**
   * Resolve a key alias to its actual value.
   *
   * @param {string | null | undefined} alias - the key alias.
   * @returns {string | null} the key value, or null if the alias is unknown
   *   and there is no default key.
   */
  function resolveKey(alias) {
    if (alias === null || alias === undefined || alias === '') {
      // No alias: use the first key as default.
      return list.length > 0 ? list[0] : null
    }
    const resolved = aliasMap.get(String(alias))
    return resolved !== undefined ? resolved : null
  }

  /**
   * Resolve an actual key value back to its alias.
   *
   * @param {string} key - the key value.
   * @returns {string | null} the alias, or null if the key is not in the pool.
   */
  function resolveAlias(key) {
    return keyToAlias.get(key) ?? null
  }

  /**
   * List all key aliases in pool order.
   *
   * @returns {string[]} aliases like `['k1', 'k2', 'k3']`.
   */
  function keyAliases() {
    return list.map((_, i) => aliasForIndex(i))
  }

  /**
   * Suggest the next key alias in round-robin order.
   *
   * This is an ADVISORY function for load distribution: a session that is
   * being created can call this to get a suggestion. The caller decides
   * whether to use the suggestion or pick a specific key.
   *
   * @returns {string | null} the next alias, or null when the pool is empty.
   */
  function nextKeyAlias() {
    if (list.length === 0) return null
    const alias = aliasForIndex(cursor)
    cursor = (cursor + 1) % list.length
    return alias
  }

  /**
   * Parse a model name that may contain a key alias suffix.
   *
   * Format: `{model-id}@{alias}` or `{model-id}` (no suffix → default key).
   *
   * @param {string} model - the model name.
   * @returns {{modelId: string, alias: string | null}}
   */
  function parseModelKey(model) {
    const s = String(model ?? '')
    const atIndex = s.lastIndexOf('@')
    if (atIndex < 0) return { modelId: s, alias: null }
    const modelId = s.slice(0, atIndex)
    const alias = s.slice(atIndex + 1)
    return { modelId, alias: alias !== '' ? alias : null }
  }

  /** Snapshot of pool state for diagnostics. */
  function stats() {
    return list.map((key, i) => ({
      index: i,
      alias: aliasForIndex(i),
      masked: maskKey(key),
    }))
  }

  return {
    size: list.length,
    resolveKey,
    resolveAlias,
    keyAliases,
    nextKeyAlias,
    parseModelKey,
    stats,
  }
}
