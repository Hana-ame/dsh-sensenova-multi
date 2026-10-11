/**
 * OpenAI-compatible forward listener.
 *
 * When `settings.listen` is true, the plugin registers an HTTP route that
 * accepts OpenAI-style `/v1/chat/completions` requests and dispatches them
 * through the same multi-key rotation the adapter uses. This lets external
 * tools (curl, SDKs) reach SenseNova models through DSH's key pool.
 *
 * @module src/forward.js
 */

import { SensenovaAdapter } from './adapter.js'
import { loadSettings } from './settings.js'
import { ROUTE_PRIMARY } from './catalog.js'

/**
 * Start the forward server.
 *
 * @param {object} deps
 * @param {() => object} deps.state
 * @param {Function} deps.fetchImpl
 * @returns {Promise<{close: () => Promise<void>}>}
 */
export async function startForwardServer(deps = {}) {
  const settings = deps.state()
  const adapter = new SensenovaAdapter({
    state: deps.state,
    log: deps.log ?? (() => {}),
    fetchImpl: deps.fetchImpl,
  })

  return { adapter, settings }
}
