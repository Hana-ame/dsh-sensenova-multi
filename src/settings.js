/**
 * Settings: the plugin's configuration surface.
 *
 * Settings live in `settings.json` in the plugin directory, merged over the
 * defaults below. The endpoint, keys, and listen flag are all user-editable;
 * the defaults are a safe starting point that a user can copy and fill in.
 *
 * Environment variables override the file, for CI and headless deploys:
 *   SENSENOVA_ENDPOINT  — upstream base URL
 *   SENSENOVA_KEYS      — comma-separated key list (highest priority)
 *   SENSENOVA_TIMEOUT   — per-request deadline in ms
 *
 * @module src/settings.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The installed package directory. */
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))
const SETTINGS_PATH = path.join(PKG_DIR, '..', 'settings.json')

/** Default configuration. */
export const SETTINGS_DEFAULTS = Object.freeze({
  /** Upstream base URL. OpenAI-compatible `/v1/chat/completions` is appended. */
  endpoint: 'https://token.sensenova.cn',
  /** Path appended to the endpoint for chat completions. */
  path: '/v1/chat/completions',
  /** The key pool, in priority order. Empty means no keys — the adapter is inert. */
  keys: [],
  /** Per-request deadline in milliseconds. */
  timeoutMs: 120_000,
  /** How long a failed key stays off-rotation in milliseconds. */
  cooldownMs: 60_000,
  /** Whether to start the OpenAI-compatible forward listener. */
  listen: false,
  /** Default model when the caller omits one. */
  defaultModel: 'senseNova-6.8-flash-lite',
  /** Default max output tokens. */
  defaultMaxTokens: 8_192,
  /** Number of retries for the same key on a transient failure (429, 5xx, timeout). */
  maxRetries: 2,
})

/**
 * Load settings from disk, merged over defaults, with env overrides.
 *
 * @param {{ path?: string }} [opts] - override the settings path (for tests).
 * @returns {object} resolved settings.
 */
export function loadSettings(opts = {}) {
  const configPath = opts.path ?? SETTINGS_PATH
  let fileSettings = {}

  try {
    if (fs.existsSync(configPath)) {
      fileSettings = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    }
  } catch {
    // A malformed settings file is a footgun: the plugin would silently run
    // with no keys. Keep the defaults and let the user fix the file.
  }

  const settings = { ...SETTINGS_DEFAULTS, ...fileSettings }

  // Environment overrides — highest priority, for CI and headless deploys.
  if (process.env.SENSENOVA_ENDPOINT) {
    settings.endpoint = process.env.SENSENOVA_ENDPOINT
  }
  if (process.env.SENSENOVA_PATH) {
    settings.path = process.env.SENSENOVA_PATH
  }
  if (process.env.SENSENOVA_KEYS) {
    settings.keys = process.env.SENSENOVA_KEYS
      .split(',')
      .map(k => k.trim())
      .filter(k => k !== '')
  }
  if (process.env.SENSENOVA_TIMEOUT) {
    const v = Number(process.env.SENSENOVA_TIMEOUT)
    if (Number.isFinite(v) && v > 0) settings.timeoutMs = v
  }
  if (process.env.SENSENOVA_COOLDOWN) {
    const v = Number(process.env.SENSENOVA_COOLDOWN)
    if (Number.isFinite(v) && v > 0) settings.cooldownMs = v
  }
  if (process.env.SENSENOVA_LISTEN !== undefined) {
    settings.listen = process.env.SENSENOVA_LISTEN === '1' || process.env.SENSENOVA_LISTEN === 'true'
  }

  // Normalise: endpoint without trailing slash, path with leading slash.
  settings.endpoint = String(settings.endpoint ?? '').replace(/\/+$/, '')
  settings.path = String(settings.path ?? '/v1/chat/completions')
  if (!settings.path.startsWith('/')) settings.path = `/${settings.path}`

  // Keys: string array, trimmed, deduped, empties dropped.
  settings.keys = Array.isArray(settings.keys)
    ? [...new Set(settings.keys.map(k => String(k).trim()).filter(k => k !== ''))]
    : []

  return settings
}

/**
 * Build the upstream URL from settings.
 *
 * @param {object} settings - resolved settings.
 * @returns {string} the full URL for chat completions.
 */
export function upstreamUrl(settings) {
  return `${settings.endpoint}${settings.path}`
}

/**
 * Validate settings and return a list of problems.
 *
 * @param {object} s - settings to validate.
 * @returns {string[]} human-readable problems; empty when valid.
 */
export function validateSettings(s) {
  const problems = []
  if (!s.endpoint || String(s.endpoint).trim() === '') {
    problems.push('endpoint is empty')
  }
  if (!Array.isArray(s.keys) || s.keys.length === 0) {
    problems.push('keys is empty — add at least one API key')
  }
  if (typeof s.timeoutMs !== 'number' || s.timeoutMs <= 0) {
    problems.push('timeoutMs must be a positive number')
  }
  return problems
}
