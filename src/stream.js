/**
 * SSE → DSH StreamChunk projection.
 *
 * The upstream answers in OpenAI-compatible Server-Sent Events. Each `data:`
 * line carries a JSON object with `choices[0].delta.content` (text delta),
 * `choices[0].delta.tool_calls` (tool call fragments), and a final `usage`
 * object. A `data: [DONE]` line terminates the stream.
 *
 * This module parses the SSE frames and yields DSH StreamChunks:
 *   block-start  → open a text block at index 0
 *   text-delta   → a content fragment
 *   block-end    → close the text block with the assembled text
 *   usage        → token usage
 *   finish       → terminal with stop/error reason
 *
 * Tool calls are yielded as tool-call-delta chunks with their own block index.
 *
 * The parser is resilient: frames split across chunk boundaries are reassembled,
 * non-JSON lines are ignored, and a stream that ends without [DONE] still
 * flushes what it has.
 *
 * @module src/stream.js
 */

/**
 * Parse an SSE response body into DSH StreamChunks.
 *
 * @param {ReadableStream} body - the response body.
 * @param {{ signal?: AbortSignal, onChunk?: (chunk: object) => void }} [opts]
 * @returns {AsyncGenerator<object>} DSH StreamChunks.
 */
export async function* parseSseStream(body, opts = {}) {
  const signal = opts.signal
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let textBlockOpen = false
  let blockIndex = 0
  let assembledText = ''
  let usage = null
  let finishReason = null
  let sawDone = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) break

      buffer += decoder.decode(value, { stream: true })

      // Split on SSE frame boundaries (double newline).
      let frameEnd
      while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, frameEnd)
        buffer = buffer.slice(frameEnd + 2)
        yield* processFrame(frame)
      }
    }

    // Flush remaining buffer.
    if (buffer.trim() !== '') {
      yield* processFrame(buffer)
    }

    // Flush any open block.
    if (textBlockOpen) {
      yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: assembledText } }
      textBlockOpen = false
    }

    // Yield usage if we saw any.
    if (usage !== null) {
      yield { type: 'usage', usage: usage }
    }

    // Yield the finish reason.
    if (finishReason !== null) {
      yield { type: 'finish', reason: finishReason }
    } else {
      // No explicit finish: end with stop if we have content, error otherwise.
      if (assembledText !== '' || usage !== null) {
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'stream closed without content' } } }
      }
    }
  } catch (error) {
    // Cancel the reader to release the connection.
    try { reader.cancel() } catch { /* already closed */ }

    if (signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'caller cancelled' } } }
      return
    }

    // If we already yielded content before the error, end with stop.
    if (assembledText !== '' || usage !== null) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const name = String(error?.name ?? '')
    const code = name === 'AbortError' ? 'ABORTED' : 'TRANSPORT'
    const kind = code === 'ABORTED' ? 'aborted' : 'error'
    yield { type: 'finish', reason: { kind, failure: { code, message: String(error?.message ?? error) } } }
  }

  /**
   * Process one SSE frame: extract the JSON from `data:` lines and yield chunks.
   */
  function* processFrame(frame) {
    const lines = frame.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      if (trimmed.startsWith('event:')) continue
      if (!trimmed.startsWith('data:')) continue

      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') {
        sawDone = true
        continue
      }
      if (data === '') continue

      let json
      try {
        json = JSON.parse(data)
      } catch {
        continue // non-JSON line; ignore
      }

      // Check for error envelope.
      if (json.error !== undefined) {
        const err = json.error
        const message = typeof err === 'string' ? err : (err?.message ?? 'upstream error')
        finishReason = { kind: 'error', failure: { code: err?.type ?? 'SERVER', message } }
        break
      }

      const choice = json.choices?.[0]
      if (!choice) {
        // No choices: might be a usage-only frame.
        if (json.usage !== undefined) {
          usage = mapUsage(json.usage)
        }
        continue
      }

      const delta = choice.delta
      if (delta === undefined || delta === null) {
        if (choice.message) {
          // Some providers send the full message in the first frame.
          const content = choice.message.content
          if (typeof content === 'string' && content !== '') {
            if (!textBlockOpen) {
              yield { type: 'block-start', index: 0, blockType: 'text' }
              textBlockOpen = true
              blockIndex = 0
            }
            yield { type: 'text-delta', index: 0, text: content }
            assembledText += content
          }
        }
        if (json.usage !== undefined) {
          usage = mapUsage(json.usage)
        }
        if (choice.finish_reason !== undefined) {
          finishReason = mapFinishReason(choice.finish_reason)
        }
        continue
      }

      // Text content delta.
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (!textBlockOpen) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          textBlockOpen = true
          blockIndex = 0
        }
        yield { type: 'text-delta', index: 0, text: delta.content }
        assembledText += delta.content
      }

      // Reasoning content delta.
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
        yield { type: 'reasoning-delta', index: 0, text: delta.reasoning_content }
      }

      // Tool call delta.
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const tcIndex = 1 + (tc.index ?? 0)
          const tcId = tc.id ?? `call_${tc.index ?? 0}`
          const tcName = tc.function?.name ?? ''
          const tcArgs = tc.function?.arguments ?? ''
          if (tcName !== '' || tcArgs !== '') {
            yield {
              type: 'tool-call-delta',
              index: tcIndex,
              id: tcId,
              name: tcName !== '' ? tcName : undefined,
              argumentsDelta: tcArgs,
            }
          }
        }
      }

      // Usage.
      if (json.usage !== undefined) {
        usage = mapUsage(json.usage)
      }

      // Finish reason.
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = mapFinishReason(choice.finish_reason)
      }
    }
  }
}

/**
 * Map an OpenAI usage object to DSH TokenUsage.
 *
 * DSH counts are disjoint: inputTokens is uncached input only. OpenAI's
 * prompt_tokens includes cache hits, so we subtract them back out.
 *
 * @param {object} usage - OpenAI usage object.
 * @returns {object} DSH TokenUsage.
 */
export function mapUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const inputTokens = usage.prompt_tokens ?? 0
  const outputTokens = usage.completion_tokens ?? 0
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWrite = usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0
  const total = usage.total_tokens ?? (inputTokens + outputTokens)
  return {
    inputTokens: Math.max(0, inputTokens - cacheRead - cacheWrite),
    outputTokens,
    totalTokens: total,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

/**
 * Map an OpenAI finish_reason to a DSH FinishReason.
 *
 * @param {string} reason - OpenAI finish_reason.
 * @returns {object} DSH FinishReason.
 */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return { kind: 'stop' }
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    default:
      return { kind: 'stop' }
  }
}

/**
 * Convert a non-streaming JSON answer into DSH StreamChunks.
 *
 * @param {object} json - the full JSON answer.
 * @returns {AsyncGenerator<object>} DSH StreamChunks.
 */
export async function* jsonToChunks(json) {
  const choice = json.choices?.[0]
  let assembledText = ''
  let hasToolCalls = false

  if (choice?.message) {
    // Text content.
    const content = choice.message.content
    if (typeof content === 'string' && content !== '') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: content }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: content } }
      assembledText = content
    }

    // Tool calls.
    if (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0) {
      hasToolCalls = true
      for (let i = 0; i < choice.message.tool_calls.length; i++) {
        const tc = choice.message.tool_calls[i]
        const tcIndex = 1 + i
        yield { type: 'block-start', index: tcIndex, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: tcIndex,
          id: tc.id ?? `call_${i}`,
          name: tc.function?.name ?? 'unknown',
          argumentsDelta: tc.function?.arguments ?? '{}',
        }
        yield { type: 'block-end', index: tcIndex, block: { type: 'tool-call', id: tc.id ?? `call_${i}`, name: tc.function?.name ?? 'unknown', input: tryParseJson(tc.function?.arguments ?? '{}') } }
      }
    }
  }

  // Usage.
  if (json.usage !== undefined) {
    yield { type: 'usage', usage: mapUsage(json.usage) }
  }

  // Finish.
  if (hasToolCalls) {
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } else {
    const reason = choice?.finish_reason
    yield { type: 'finish', reason: mapFinishReason(reason) }
  }
}

function tryParseJson(text) {
  try { return JSON.parse(text) } catch { return {} }
}
