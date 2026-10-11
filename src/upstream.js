/**
 * The real dispatch: one key, one request, one answer.
 *
 * Kept separate from the rotation loop because it is the only part of the
 * layer that touches the wire. `stream()` decides which key to try; this
 * performs. Inject `fetchImpl` in tests and the whole loop runs against an
 * in-process server.
 *
 * The upstream speaks OpenAI-compatible Chat Completions:
 *   POST {endpoint}{path}
 *   Authorization: Bearer <key>
 *   Content-Type: application/json
 *   Accept: text/event-stream (when streaming)
 *
 *   body: { model, messages, stream, temperature, max_tokens, stop, tools }
 *
 * A 2xx response is either a JSON answer (non-stream) or an SSE stream
 * (stream). A non-2xx is classified and thrown as a `UpstreamError` carrying
 * the code, status, and a summary of the body.
 *
 * @module src/upstream.js
 */

import { CODE, classifyHttpStatus, classifyFetchError, summarizeErrorBody, isRetryable } from './errors.js'

export const SERVICE_UA = 'dsh-sensenova-multi/1.0.0'
export const DEFAULT_TIMEOUT_MS = 120_000

/**
 * A classified upstream failure. The rotation loop reads `code` to decide
 * whether to switch keys; `retryable` is a convenience alias.
 */
export class UpstreamError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    this.statusCode = details.statusCode
    this.retryable = details.retryable ?? isRetryable(code)
    this.body = details.body ?? ''
    this.keyIndex = details.keyIndex
    this.keyMasked = details.keyMasked
  }
}

/**
 * Build the OpenAI chat body from DSH GenerateOptions.
 *
 * DSH messages are folded into the OpenAI chat shape:
 *   system/developer → system
 *   tool results    → keep role, preserve tool_call_id
 *   text blocks     → text
 *   reasoning       → text, prefixed [thinking]
 *   image blocks    → multimodal content array
 *   tool calls      → assistant tool_calls
 *
 * @param {object} options - GenerateOptions.
 * @returns {object} OpenAI-shaped request body.
 */
export function toChatBody(options) {
  const messages = []
  let systemText = ''

  if (typeof options.system === 'string' && options.system.trim() !== '') {
    systemText = options.system
  }

  for (const message of options.messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const toolCalls = []
    const textParts = []
    let content = ''
    let hasImage = false

    if (typeof message.content === 'string') {
      content = message.content
    } else if (blocks.length === 0) {
      if (message.role === 'user' && message.text !== undefined) content = String(message.text)
      else continue
    } else {
      for (const block of blocks) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text !== '') textParts.push(block.text)
        } else if (block.type === 'reasoning') {
          if (typeof block.text === 'string' && block.text !== '') textParts.push(`[thinking] ${block.text}`)
        } else if (block.type === 'image') {
          hasImage = true
          if (block.source?.data !== undefined || block.data !== undefined || block.url !== undefined) {
            // Collect image references for multimodal content.
            textParts.push(`[image: ${block.source?.type === 'base64' ? 'base64' : 'url'}]`)
          }
        } else if (block.type === 'tool-call') {
          toolCalls.push({
            id: block.id ?? `call_${toolCalls.length}`,
            type: 'function',
            function: {
              name: block.name ?? 'unknown',
              arguments: JSON.stringify(block.input ?? {}),
            },
          })
        }
      }
      content = textParts.join('\n')
    }

    if (message.role === 'system' || message.role === 'developer') {
      // A developer message is a system prompt; fold into systemText.
      systemText = systemText ? `${systemText}\n\n${content}` : content
      continue
    }

    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: message.tool_call_id ?? message.id ?? '',
        content,
      })
      continue
    }

    const msg = { role: message.role, content }
    if (toolCalls.length > 0) msg.tool_calls = toolCalls
    messages.push(msg)
  }

  if (systemText !== '') {
    messages.unshift({ role: 'system', content: systemText })
  }

  const body = {
    model: options.model,
    messages,
    stream: true,
  }

  if (typeof options.temperature === 'number') body.temperature = options.temperature
  if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop

  // Tools: map DSH ToolSchema[] to OpenAI tool format.
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? {},
      },
    }))
  }

  return body
}

/**
 * Build headers for one request.
 *
 * @param {string} key - the API key.
 * @param {boolean} stream - whether the request asks for a stream.
 * @returns {Record<string, string>}
 */
export function buildHeaders(key, stream) {
  return {
    'content-type': 'application/json',
    'user-agent': SERVICE_UA,
    'authorization': `Bearer ${key}`,
    'accept': stream ? 'text/event-stream' : 'application/json',
  }
}

/**
 * Dispatch one request to the upstream.
 *
 * @param {object} args
 * @param {string} args.url - the full upstream URL.
 * @param {string} args.key - the API key.
 * @param {object} args.body - the request body.
 * @param {object} [args.signal] - caller's AbortSignal.
 * @param {number} [args.timeoutMs] - per-attempt deadline.
 * @param {number} [args.keyIndex] - index of this key in the pool.
 * @param {string} [args.keyMasked] - masked key for diagnostics.
 * @param {Function} [args.fetchImpl] - injectable transport.
 * @returns {Promise<{statusCode: number, json?: object, body?: ReadableStream, stream: boolean, headers: Record<string,string>}>}
 * @throws {UpstreamError} with a classified code.
 */
export async function dispatch({
  url,
  key,
  body,
  signal,
  timeoutMs,
  keyIndex,
  keyMasked,
  fetchImpl,
}) {
  const fetcher = typeof fetchImpl === 'function'
    ? fetchImpl
    : typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : null

  if (fetcher === null) {
    throw new UpstreamError('no fetch implementation available', CODE.config, { keyIndex, keyMasked })
  }
  if (!url || String(url).trim() === '') {
    throw new UpstreamError('empty upstream url', CODE.config, { keyIndex, keyMasked })
  }

  const wantsStream = body?.stream === true
  const headers = buildHeaders(key, wantsStream)
  const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  const deadline = AbortSignal.timeout(deadlineMs)
  const combined = signal && !signal.aborted ? AbortSignal.any([signal, deadline]) : deadline

  // If the caller already aborted, fail fast with an ABORTED code.
  if (signal?.aborted === true) {
    throw new UpstreamError('caller cancelled', CODE.aborted, { keyIndex, keyMasked })
  }

  let response
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (error) {
    const code = classifyFetchError(error, { callerSignal: signal, deadlineSignal: deadline })
    throw new UpstreamError(String(error?.message ?? error), code, {
      keyIndex,
      keyMasked,
    })
  }

  const status = response.status
  const responseHeaders = {}
  if (response.headers) {
    if (response.headers.entries) {
      for (const [k, v] of response.headers.entries()) responseHeaders[k.toLowerCase()] = v
    } else if (typeof response.headers.forEach === 'function') {
      response.headers.forEach((v, k) => { responseHeaders[k.toLowerCase()] = v })
    }
  }

  if (status >= 200 && status < 300) {
    // Success path.
    if (wantsStream && response.body) {
      return { statusCode: status, body: response.body, stream: true, headers: responseHeaders }
    }
    // Non-stream JSON.
    let json = null
    try { json = await response.json() } catch { /* not JSON */ }
    if (json === null) {
      throw new UpstreamError('empty response body', CODE.empty, {
        statusCode: status,
        retryable: true,
        keyIndex,
        keyMasked,
      })
    }
    // Check for an error envelope inside a 2xx.
    if (json.error !== undefined) {
      const code = classifyHttpStatus(status, JSON.stringify(json.error))
      throw new UpstreamError(summarizeErrorBody(JSON.stringify(json.error)), code, {
        statusCode: status,
        body: JSON.stringify(json.error),
        retryable: isRetryableCode(code),
        keyIndex,
        keyMasked,
      })
    }
    return { statusCode: status, json, stream: false, headers: responseHeaders }
  }

  // Non-2xx: read the body for classification, then throw.
  let text = ''
  try {
    text = await response.text()
  } catch { /* ignore */ }
  const code = classifyHttpStatus(status, text)
  throw new UpstreamError(
    summarizeErrorBody(text),
    code,
    {
      statusCode: status,
      body: text,
      retryable: isRetryableCode(code),
      keyIndex,
      keyMasked,
    },
  )
}

function isRetryableCode(code) {
  return isRetryable(code)
}
