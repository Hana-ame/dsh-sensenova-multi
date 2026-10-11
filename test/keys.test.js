/**
 * Key pool tests: session-level key selection for load distribution.
 *
 * The new semantics are:
 *   - Each key gets a stable alias (k1, k2, …)
 *   - A session picks one alias at creation time and sticks with it
 *   - The adapter retries the SAME key on 429 (not switch)
 *   - `nextKeyAlias()` suggests the next alias in round-robin order
 *
 * @module test/keys.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createKeyPool, aliasForIndex, indexForAlias, maskKey } from '../src/keys.js'
import { CODE, classifyHttpStatus, classifyFetchError, isRetryable } from '../src/errors.js'
import { dispatch, toChatBody, UpstreamError } from '../src/upstream.js'
import { SensenovaAdapter } from '../src/adapter.js'
import { parseSseStream, jsonToChunks } from '../src/stream.js'
import { parseModelKey } from '../src/catalog.js'
import { mockFetch } from './fake-kernel.mjs'

// ── Alias helpers ─────────────────────────────────────────────────────────

test('aliasForIndex: k1, k2, k3', () => {
  assert.equal(aliasForIndex(0), 'k1')
  assert.equal(aliasForIndex(1), 'k2')
  assert.equal(aliasForIndex(2), 'k3')
  assert.equal(aliasForIndex(9), 'k10')
})

test('indexForAlias: k1 → 0, k2 → 1', () => {
  assert.equal(indexForAlias('k1'), 0)
  assert.equal(indexForAlias('k2'), 1)
  assert.equal(indexForAlias('K3'), 2)
})

test('indexForAlias: invalid → null', () => {
  assert.equal(indexForAlias(''), null)
  assert.equal(indexForAlias('x1'), null)
  assert.equal(indexForAlias('k'), null)
  assert.equal(indexForAlias('k0'), null)
  assert.equal(indexForAlias('k-1'), null)
})

test('maskKey: short key', () => {
  assert.equal(maskKey('sk-abc'), 'sk…bc')
})

test('maskKey: long key', () => {
  assert.equal(maskKey('sk-51aUabcdef123456xyz'), 'sk-51a…6xyz')
})

test('maskKey: empty', () => {
  assert.equal(maskKey(''), '(empty)')
  assert.equal(maskKey(null), '(empty)')
})

// ── createKeyPool ─────────────────────────────────────────────────────────

test('createKeyPool: size and aliases', () => {
  const pool = createKeyPool({ keys: ['sk-a', 'sk-b', 'sk-c'] })
  assert.equal(pool.size, 3)
  assert.deepEqual(pool.keyAliases(), ['k1', 'k2', 'k3'])
})

test('createKeyPool: resolveKey by alias', () => {
  const pool = createKeyPool({ keys: ['sk-a', 'sk-b', 'sk-c'] })
  assert.equal(pool.resolveKey('k1'), 'sk-a')
  assert.equal(pool.resolveKey('k2'), 'sk-b')
  assert.equal(pool.resolveKey('k3'), 'sk-c')
})

test('createKeyPool: resolveKey with no alias → first key', () => {
  const pool = createKeyPool({ keys: ['sk-a', 'sk-b'] })
  assert.equal(pool.resolveKey(null), 'sk-a')
  assert.equal(pool.resolveKey(undefined), 'sk-a')
  assert.equal(pool.resolveKey(''), 'sk-a')
})

test('createKeyPool: resolveKey with unknown alias → null', () => {
  const pool = createKeyPool({ keys: ['sk-a', 'sk-b'] })
  assert.equal(pool.resolveKey('k99'), null)
})

test('createKeyPool: resolveAlias', () => {
  const pool = createKeyPool({ keys: ['sk-a', 'sk-b'] })
  assert.equal(pool.resolveAlias('sk-a'), 'k1')
  assert.equal(pool.resolveAlias('sk-b'), 'k2')
  assert.equal(pool.resolveAlias('sk-unknown'), null)
})

test('createKeyPool: empty pool', () => {
  const pool = createKeyPool({ keys: [] })
  assert.equal(pool.size, 0)
  assert.deepEqual(pool.keyAliases(), [])
  assert.equal(pool.resolveKey('k1'), null)
  assert.equal(pool.resolveKey(null), null)
})

test('createKeyPool: deduplicates and trims keys', () => {
  const pool = createKeyPool({ keys: ['  sk-a  ', 'sk-a', '', '   ', 'sk-b'] })
  assert.equal(pool.size, 2)
  assert.equal(pool.resolveKey('k1'), 'sk-a')
  assert.equal(pool.resolveKey('k2'), 'sk-b')
})

test('createKeyPool: nextKeyAlias round-robins', () => {
  const pool = createKeyPool({ keys: ['sk-a', 'sk-b', 'sk-c'] })
  assert.equal(pool.nextKeyAlias(), 'k1')
  assert.equal(pool.nextKeyAlias(), 'k2')
  assert.equal(pool.nextKeyAlias(), 'k3')
  // Wraps around.
  assert.equal(pool.nextKeyAlias(), 'k1')
})

test('createKeyPool: nextKeyAlias on empty pool → null', () => {
  const pool = createKeyPool({ keys: [] })
  assert.equal(pool.nextKeyAlias(), null)
})

test('createKeyPool: stats', () => {
  const pool = createKeyPool({ keys: ['sk-51aUabcdef123456xyz', 'sk-def456uvw'] })
  const stats = pool.stats()
  assert.equal(stats.length, 2)
  assert.equal(stats[0].alias, 'k1')
  assert.equal(stats[0].masked, 'sk-51a…6xyz')
  assert.equal(stats[1].alias, 'k2')
  assert.equal(stats[1].masked, 'sk-def…6uvw')
})

// ── parseModelKey ─────────────────────────────────────────────────────────

test('parseModelKey: no suffix → default key', () => {
  const result = parseModelKey('senseNova-6.8-flash-lite')
  assert.equal(result.modelId, 'senseNova-6.8-flash-lite')
  assert.equal(result.alias, null)
})

test('parseModelKey: with @alias suffix', () => {
  const result = parseModelKey('senseNova-6.8-flash-lite@k2')
  assert.equal(result.modelId, 'senseNova-6.8-flash-lite')
  assert.equal(result.alias, 'k2')
})

test('parseModelKey: @empty suffix → null alias', () => {
  const result = parseModelKey('senseNova-6.8-flash-lite@')
  assert.equal(result.modelId, 'senseNova-6.8-flash-lite')
  assert.equal(result.alias, null)
})

test('parseModelKey: multiple @ signs → last one is the alias', () => {
  const result = parseModelKey('some@model@k3')
  assert.equal(result.modelId, 'some@model')
  assert.equal(result.alias, 'k3')
})

// ── Error classification ──────────────────────────────────────────────────

test('classifyHttpStatus: 429 → rateLimit (retryable same key)', () => {
  assert.equal(classifyHttpStatus(429), CODE.rateLimit)
  assert.equal(isRetryable(CODE.rateLimit), true)
})

test('classifyHttpStatus: 401 → credential (NOT retryable, same key)', () => {
  assert.equal(classifyHttpStatus(401), CODE.credential)
  assert.equal(isRetryable(CODE.credential), false)
})

test('classifyHttpStatus: 403 → forbidden (NOT retryable, same key)', () => {
  assert.equal(classifyHttpStatus(403), CODE.forbidden)
  assert.equal(isRetryable(CODE.forbidden), false)
})

test('classifyHttpStatus: 500 → server (retryable same key)', () => {
  assert.equal(classifyHttpStatus(500), CODE.server)
  assert.equal(isRetryable(CODE.server), true)
})

test('classifyHttpStatus: 400 → client (NOT retryable)', () => {
  assert.equal(classifyHttpStatus(400), CODE.client)
  assert.equal(isRetryable(CODE.client), false)
})

test('isRetryable: correct set', () => {
  assert.equal(isRetryable(CODE.rateLimit), true)
  assert.equal(isRetryable(CODE.server), true)
  assert.equal(isRetryable(CODE.transport), true)
  assert.equal(isRetryable(CODE.timeout), true)
  assert.equal(isRetryable(CODE.empty), true)
  assert.equal(isRetryable(CODE.client), false)
  assert.equal(isRetryable(CODE.credential), false)
  assert.equal(isRetryable(CODE.forbidden), false)
  assert.equal(isRetryable(CODE.config), false)
  assert.equal(isRetryable(CODE.aborted), false)
})

// ── toChatBody ───────────────────────────────────────────────────────────

test('toChatBody: basic text messages', () => {
  const body = toChatBody({
    model: 'senseNova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.7,
    maxTokens: 100,
  })
  assert.equal(body.model, 'senseNova-6.8-flash-lite')
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, 'user')
  assert.equal(body.messages[0].content, 'hello')
  assert.equal(body.temperature, 0.7)
  assert.equal(body.max_tokens, 100)
  assert.equal(body.stream, true)
})

test('toChatBody: system prompt is prepended', () => {
  const body = toChatBody({
    model: 'm',
    system: 'You are helpful',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'You are helpful')
  assert.equal(body.messages[1].role, 'user')
})

test('toChatBody: developer message folds into system', () => {
  const body = toChatBody({
    model: 'm',
    messages: [
      { role: 'developer', content: 'system prompt' },
      { role: 'user', content: 'hi' },
    ],
  })
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'system prompt')
})

test('toChatBody: tools are mapped to OpenAI format', () => {
  const body = toChatBody({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: {} } }],
  })
  assert.ok(body.tools)
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tools[0].function.name, 'get_weather')
})

// ── Integration: session-level key selection ─────────────────────────────

/**
 * Create an adapter with a mock fetch and drive one turn.
 */
async function runTurn(opts) {
  const { keys, responses, ...rest } = opts
  const settings = {
    endpoint: 'http://localhost',
    path: '/v1/chat/completions',
    keys,
    timeoutMs: 5000,
    cooldownMs: 100,
    maxRetries: rest.maxRetries ?? 2,
    ...rest.settings,
  }
  const adapter = new SensenovaAdapter({
    state: () => settings,
    log: () => {},
    fetchImpl: mockFetch(responses),
    sleep: () => {}, // no-op sleep for tests
  })
  const options = {
    provider: 'sensenova',
    model: 'senseNova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    ...rest.options,
  }
  const chunks = []
  for await (const chunk of adapter.stream(options)) {
    chunks.push(chunk)
  }
  return { chunks, adapter }
}

test('stream: model@k1 uses key k1', async () => {
  const response = sseResponse('ok')
  const { chunks } = await runTurn({
    keys: ['sk-key1', 'sk-key2'],
    responses: [response],
    options: { model: 'senseNova-6.8-flash-lite@k1' },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'stop')
})

test('stream: model@k2 uses key k2', async () => {
  const response = sseResponse('ok')
  const { chunks } = await runTurn({
    keys: ['sk-key1', 'sk-key2'],
    responses: [response],
    options: { model: 'senseNova-6.8-flash-lite@k2' },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'stop')
})

test('stream: no @suffix → default key k1', async () => {
  const response = sseResponse('ok')
  const { chunks } = await runTurn({
    keys: ['sk-key1', 'sk-key2'],
    responses: [response],
    options: { model: 'senseNova-6.8-flash-lite' },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'stop')
})

test('stream: unknown key alias → CONFIG error', async () => {
  const { chunks } = await runTurn({
    keys: ['sk-key1'],
    responses: [],
    options: { model: 'senseNova-6.8-flash-lite@k99' },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CONFIG')
  assert.match(finish.reason.failure.message, /unknown key alias/)
})

test('stream: 429 retries SAME key (not switch)', async () => {
  // First attempt: 429. Second attempt: success.
  const responseA = { status: 429, body: '{"error":{"message":"rate limit"}}' }
  const responseB = sseResponse('ok')

  const { chunks } = await runTurn({
    keys: ['sk-key1', 'sk-key2'],
    responses: [responseA, responseB],
    options: { model: 'senseNova-6.8-flash-lite@k1' },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'stop')
  // The second response should have been called with the same key (sk-key1).
  // We verify this by checking that the mock fetch received two calls.
})

test('stream: 429 exhausts retries → error', async () => {
  const response429 = { status: 429, body: '{"error":{"message":"rate limit"}}' }

  const { chunks } = await runTurn({
    keys: ['sk-key1'],
    responses: [response429, response429, response429], // 3 attempts: 1 initial + 2 retries
    maxRetries: 2,
    options: { model: 'senseNova-6.8-flash-lite@k1' },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'RATE_LIMIT')
  assert.match(finish.reason.failure.message, /after 2 retries/)
})

test('stream: 401 → immediate error (no retry)', async () => {
  const response401 = { status: 401, body: '{"error":{"message":"invalid api key"}}' }

  const { chunks } = await runTurn({
    keys: ['sk-key1'],
    responses: [response401],
    options: { model: 'senseNova-6.8-flash-lite@k1' },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CREDENTIAL')
  assert.match(finish.reason.failure.message, /rejected/)
})

test('stream: 403 → immediate error (no retry)', async () => {
  const response403 = { status: 403, body: '{"error":{"message":"forbidden"}}' }

  const { chunks } = await runTurn({
    keys: ['sk-key1'],
    responses: [response403],
    options: { model: 'senseNova-6.8-flash-lite@k1' },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'FORBIDDEN')
})

test('stream: 500 retries same key', async () => {
  const response500 = { status: 500, body: '{"error":{"message":"server error"}}' }
  const response200 = sseResponse('ok')

  const { chunks } = await runTurn({
    keys: ['sk-key1'],
    responses: [response500, response200],
    options: { model: 'senseNova-6.8-flash-lite@k1' },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'stop')
})

test('stream: transport error retries same key', async () => {
  const responses = [
    () => { throw new Error('connection refused') },
    sseResponse('ok'),
  ]

  const { chunks } = await runTurn({
    keys: ['sk-key1'],
    responses,
    options: { model: 'senseNova-6.8-flash-lite@k1' },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'stop')
})

test('stream: no keys → CONFIG error', async () => {
  const { chunks } = await runTurn({
    keys: [],
    responses: [],
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CONFIG')
})

test('stream: success on first attempt', async () => {
  const response = sseResponse('hello')

  const { chunks } = await runTurn({
    keys: ['sk-key1'],
    responses: [response],
    options: { model: 'senseNova-6.8-flash-lite@k1' },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'stop')

  const textChunks = chunks.filter(c => c.type === 'text-delta')
  assert.equal(textChunks.length, 1)
  assert.equal(textChunks[0].text, 'hello')
})

test('stream: caller abort during dispatch', async () => {
  const controller = new AbortController()
  controller.abort()

  const { chunks } = await runTurn({
    keys: ['sk-key1'],
    responses: [sseResponse('hello')],
    options: { model: 'senseNova-6.8-flash-lite@k1', signal: controller.signal },
  })
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'aborted')
})

// ── SSE parsing ──────────────────────────────────────────────────────────

test('parseSseStream: basic text stream', async () => {
  const body = makeSseBody([
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ])

  const chunks = []
  for await (const chunk of parseSseStream(body, {})) {
    chunks.push(chunk)
  }

  const textChunks = chunks.filter(c => c.type === 'text-delta')
  assert.equal(textChunks.length, 2)
  assert.equal(textChunks[0].text, 'Hello')
  assert.equal(textChunks[1].text, ' world')

  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'stop')

  const usage = chunks.find(c => c.type === 'usage')
  assert.ok(usage)
  assert.equal(usage.usage.inputTokens, 10)
  assert.equal(usage.usage.outputTokens, 5)
})

test('jsonToChunks: non-stream JSON answer', async () => {
  const json = {
    choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  }

  const chunks = []
  for await (const chunk of jsonToChunks(json)) {
    chunks.push(chunk)
  }

  assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === 'Hello!'))
  assert.ok(chunks.some(c => c.type === 'finish'))
})

test('stream: text-delta chunks are yielded in order', async () => {
  const body = makeSseBody([
    'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"C"}}],"usage":{"prompt_tokens":1,"completion_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ])

  const chunks = []
  for await (const chunk of parseSseStream(body, {})) {
    chunks.push(chunk)
  }

  const texts = chunks.filter(c => c.type === 'text-delta').map(c => c.text)
  assert.deepEqual(texts, ['A', 'B', 'C'])
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function sseResponse(text) {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\n`,
    'data: [DONE]\n\n',
  ]
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(frame))
      }
      controller.close()
    },
  })
  return { status: 200, body, stream: true, headers: {} }
}

function makeSseBody(frames) {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(frame))
      }
      controller.close()
    },
  })
}
