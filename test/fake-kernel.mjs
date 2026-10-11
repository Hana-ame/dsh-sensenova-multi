/**
 * Test scaffolding: a fake cordis context and an in-process upstream stub.
 *
 * The upstream stub is an HTTP server that answers POST requests with
 * scripted responses. Each request is recorded so a test can assert which key
 * was used and in what order.
 *
 * Nothing here imports the plugin, because `settings.js` reads settings.json
 * at import time. A test sets the environment, then imports dynamically.
 *
 * @module test/fake-kernel.mjs
 */

import http from 'node:http'

/**
 * Start the stand-in upstream gateway.
 *
 * @param {object} options
 * @param {Array<{status?: number, body?: string, contentType?: string} | ((req: object) => object)>} options.responses
 *   one response per request, in order. Each entry is either a static response
 *   or a function that receives the request body and returns a response.
 * @param {function} [options.onError] - called when a request arrives beyond the scripted list.
 * @returns {Promise<{base: string, requests: Array<object>, close: () => Promise<void>}>}
 */
export async function stubUpstream({ responses = [], onError } = {}) {
  const requests = []
  let requestIndex = 0

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', row => chunks.push(row))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const authHeader = req.headers.authorization ?? ''
      const key = authHeader.replace(/^Bearer\s+/i, '')
      const request = { path: req.url, method: req.method, body, key, headers: req.headers }
      requests.push(request)

      const responseSpec = requestIndex < responses.length
        ? responses[requestIndex]
        : (onError ? onError(request) : { status: 200, body: '{"choices":[]}' })
      const resolved = typeof responseSpec === 'function' ? responseSpec(request) : responseSpec
      requestIndex += 1

      const status = resolved.status ?? 200
      const contentType = resolved.contentType ?? (status === 200 ? 'application/json' : 'application/json')

      if (resolved.stream === true) {
        // SSE stream response.
        res.writeHead(status, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        })
        const frames = resolved.frames ?? []
        for (const frame of frames) {
          res.write(frame)
        }
        res.end()
      } else {
        res.writeHead(status, { 'content-type': contentType })
        res.end(resolved.body ?? '')
      }
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  server.unref()

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/**
 * A one-shot fetch implementation that returns scripted responses.
 *
 * @param {Array<{status?: number, body?: string} | ((url: string, init: object) => object)>} responses
 * @returns {Function} a fetch-compatible function.
 */
export function mockFetch(responses = []) {
  let callIndex = 0
  return async function mockFetchImpl(url, init = {}) {
    const signal = init.signal
    // Respect an already-aborted signal: throw like a real fetch would.
    if (signal?.aborted === true) {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }

    const spec = callIndex < responses.length ? responses[callIndex] : { status: 500, body: '{"error":{"message":"no more responses"}}' }
    callIndex += 1
    const resolved = typeof spec === 'function' ? spec(url, init) : spec
    const status = resolved.status ?? 200

    // Build headers from the resolved spec.
    const headers = new Headers()
    for (const [k, v] of Object.entries(resolved.headers ?? {})) {
      headers.set(k, v)
    }
    if (!resolved.headers?.['content-type'] && !resolved.headers?.['Content-Type']) {
      headers.set('content-type', 'application/json')
    }

    const body = resolved.body ?? ''
    const response = new Response(body, {
      status,
      headers,
    })
    return response
  }
}

/**
 * Build a fake cordis context.
 *
 * @param {object} options
 * @param {string[]} options.inject - declared services.
 * @param {string[]} [options.mounted] - mounted service names.
 * @returns {object} a cordis-shaped context.
 */
export function fakeContext({ inject = [], mounted = ['llm'] } = {}) {
  const captured = { adapters: [], routes: [], registrations: [], events: [] }
  const mountedSet = new Set(mounted)

  const services = {
    llm: {
      listProviders: () => captured.routes.map(id => ({ id, name: id })),
      registerAdapter(routes, adapter) {
        captured.adapters.push({ routes, adapter })
        captured.routes.push(...routes)
        return Object.assign(() => {}, { replace: next => captured.registrations.push(next) })
      },
      registerConfigurableProviders(entries) { captured.configurable = entries; return () => {} },
      registerModelDiscovery(ns, fn) { captured.discovery = fn; return () => {} },
    },
    webServer: {
      register(route) { captured.serverRoutes = captured.serverRoutes || []; captured.serverRoutes.push(route); return () => {} },
      port: 0,
      host: '127.0.0.1',
    },
    timer: { interval: (fn, ms) => { return () => {} } },
    connection: { admit: () => undefined },
    attachments: { imageHostPath: () => undefined },
  }

  const ctx = {
    logger: {
      warn: m => captured.logs?.push(`warn ${m}`),
      info: m => captured.logs?.push(`info ${m}`),
      error: m => captured.logs?.push(`error ${m}`),
      debug: () => {},
      log: m => captured.logs?.push(`log ${m}`),
    },
    fiber: { entry: { options: { id: 'sensenova-multi' } } },
    get: name => (mountedSet.has(name) ? services[name] : undefined),
    on: event => { captured.events.push(event); return () => {} },
    emit: event => { captured.events.push(`emit:${event}`) },
    effect: fn => { try { fn() } catch (e) { captured.logs?.push(`effect-error ${e.message}`) } return { [Symbol.dispose]: () => {} } },
    inject: (deps, callback) => {
      const scoped = Object.create(ctx)
      for (const name of deps) scoped[name] = services[name]
      queueMicrotask(() => callback(scoped))
      return { [Symbol.dispose]: () => {} }
    },
    interval: (fn, ms) => () => {},
    timeout: (fn, ms) => () => {},
    __captured: captured,
  }
  // Attach services directly so apply() can read ctx.llm etc. without inject.
  for (const name of mounted) {
    if (services[name]) ctx[name] = services[name]
  }
  return ctx
}
