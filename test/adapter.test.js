/**
 * Adapter tests: the seven LlmAdapter contract methods + index.js apply().
 *
 * Updated for session-level key selection semantics:
 *   - listModels returns key-qualified models (model@k1, model@k2)
 *   - resolveModel parses @key suffix
 *   - stream retries the SAME key on 429 (not switch)
 *
 * @module test/adapter.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SensenovaAdapter } from '../src/adapter.js'
import { ROUTE_PRIMARY, ROUTE_MULTI, DEFAULT_MODEL } from '../src/catalog.js'
import { fakeContext } from './fake-kernel.mjs'

function makeAdapter(settings) {
  return new SensenovaAdapter({
    state: () => ({
      endpoint: 'http://localhost',
      path: '/v1/chat/completions',
      keys: ['sk-test-key-1', 'sk-test-key-2'],
      timeoutMs: 5000,
      cooldownMs: 100,
      maxRetries: 2,
      ...settings,
    }),
    log: () => {},
  })
}

// ── 1. providerInfo ────────────────────────────────────────────────────────

test('providerInfo: primary route', () => {
  const adapter = makeAdapter({})
  const info = adapter.providerInfo(ROUTE_PRIMARY)
  assert.equal(info.id, 'sensenova')
  assert.equal(info.name, 'SenseNova')
})

test('providerInfo: multi route', () => {
  const adapter = makeAdapter({})
  const info = adapter.providerInfo(ROUTE_MULTI)
  assert.equal(info.id, 'sensenova-multi')
  assert.equal(info.name, 'SenseNova · multi-key')
})

test('providerInfo: unknown route → falls back to route name', () => {
  const adapter = makeAdapter({})
  const info = adapter.providerInfo('unknown-route')
  assert.equal(info.id, 'unknown-route')
  assert.equal(info.name, 'unknown-route')
})

// ── 2. providerRetryPolicy ─────────────────────────────────────────────────

test('providerRetryPolicy: returns frozen normal policy with 0 retries', () => {
  const adapter = makeAdapter({})
  const policy = adapter.providerRetryPolicy(ROUTE_PRIMARY)
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 0)
  assert.ok(Object.isFrozen(policy))
  assert.equal(policy.retryableCodes.length, 0)
})

// ── 3. imageRequestPricing ─────────────────────────────────────────────────

test('imageRequestPricing: returns undefined', () => {
  const adapter = makeAdapter({})
  assert.equal(adapter.imageRequestPricing(ROUTE_PRIMARY, 'senseNova-6.8-flash-lite'), undefined)
})

// ── 4. listModels ──────────────────────────────────────────────────────────

test('listModels: returns key-qualified models', async () => {
  const adapter = makeAdapter({})
  const models = await adapter.listModels(ROUTE_PRIMARY)
  assert.ok(Array.isArray(models))
  assert.ok(models.length > 0)

  // Should have models with @k1, @k2 suffixes.
  const ids = models.map(m => m.id)
  assert.ok(ids.some(id => id.endsWith('@k1')), 'should have @k1 models')
  assert.ok(ids.some(id => id.endsWith('@k2')), 'should have @k2 models')

  // Each model should have two entries (one per key).
  const baseModels = models.filter(m => m.id.endsWith('@k1')).map(m => m.id.replace(/@k1$/, ''))
  const baseModels2 = models.filter(m => m.id.endsWith('@k2')).map(m => m.id.replace(/@k2$/, ''))
  assert.deepEqual(baseModels, baseModels2)
})

test('listModels: includes provider and name fields', async () => {
  const adapter = makeAdapter({})
  const models = await adapter.listModels(ROUTE_PRIMARY)
  assert.ok(models.length > 0)
  for (const model of models) {
    assert.equal(model.provider, ROUTE_PRIMARY)
    assert.ok(typeof model.id === 'string')
    assert.ok(typeof model.name === 'string')
    assert.ok(typeof model.inputModalities === 'object')
  }
})

test('listModels: empty keys → no key suffixes', async () => {
  const adapter = makeAdapter({ keys: [] })
  const models = await adapter.listModels(ROUTE_PRIMARY)
  assert.ok(Array.isArray(models))
  assert.ok(models.length > 0)
  // No @ suffixes.
  for (const model of models) {
    assert.equal(model.id.includes('@'), false)
  }
})

test('listModels: vision model has image modality', async () => {
  const adapter = makeAdapter({})
  const models = await adapter.listModels(ROUTE_PRIMARY)
  const vision = models.find(m => m.id.includes('vision'))
  assert.ok(vision)
  assert.ok(vision.inputModalities.includes('image'))
})

test('listModels: text model has only text modality', async () => {
  const adapter = makeAdapter({})
  const models = await adapter.listModels(ROUTE_PRIMARY)
  const text = models.find(m => m.id.startsWith('senseNova-6.8-flash-lite@k1'))
  assert.ok(text)
  assert.equal(text.inputModalities.length, 1)
  assert.equal(text.inputModalities[0], 'text')
})

// ── 5. resolveModel ────────────────────────────────────────────────────────

test('resolveModel: known model returns context info', async () => {
  const adapter = makeAdapter({})
  const resolved = await adapter.resolveModel(ROUTE_PRIMARY, 'senseNova-6.8-flash-lite', new AbortController().signal)
  assert.equal(resolved.id, 'senseNova-6.8-flash-lite')
  assert.ok(resolved.context)
  assert.ok(resolved.context.contextWindow > 0)
  assert.ok(resolved.defaultMaxTokens > 0)
})

test('resolveModel: model@k2 returns alias in name', async () => {
  const adapter = makeAdapter({})
  const resolved = await adapter.resolveModel(ROUTE_PRIMARY, 'senseNova-6.8-flash-lite@k2', new AbortController().signal)
  assert.equal(resolved.id, 'senseNova-6.8-flash-lite@k2')
  assert.ok(resolved.name.includes('k2'))
  assert.ok(resolved.context.contextWindow > 0)
})

test('resolveModel: unknown model falls back to defaults', async () => {
  const adapter = makeAdapter({})
  const resolved = await adapter.resolveModel(ROUTE_PRIMARY, 'unknown-model', new AbortController().signal)
  assert.ok(resolved)
  assert.ok(resolved.context.contextWindow > 0)
  assert.ok(resolved.defaultMaxTokens > 0)
})

test('resolveModel: unknown model@k1 falls back with alias', async () => {
  const adapter = makeAdapter({})
  const resolved = await adapter.resolveModel(ROUTE_PRIMARY, 'unknown-model@k1', new AbortController().signal)
  assert.ok(resolved)
  assert.equal(resolved.id, 'unknown-model@k1')
  assert.ok(resolved.context.contextWindow > 0)
})

// ── 6. prepareCall ─────────────────────────────────────────────────────────

test('prepareCall: returns model and stream closure', async () => {
  const adapter = makeAdapter({})
  const prepared = await adapter.prepareCall(ROUTE_PRIMARY, 'senseNova-6.8-flash-lite', new AbortController().signal)
  assert.ok(prepared.model)
  assert.equal(prepared.model.id, 'senseNova-6.8-flash-lite')
  assert.equal(typeof prepared.stream, 'function')
})

test('prepareCall: with @k2 suffix', async () => {
  const adapter = makeAdapter({})
  const prepared = await adapter.prepareCall(ROUTE_PRIMARY, 'senseNova-6.8-flash-lite@k2', new AbortController().signal)
  assert.ok(prepared.model)
  assert.equal(prepared.model.id, 'senseNova-6.8-flash-lite@k2')
})

// ── 7. stream ──────────────────────────────────────────────────────────────

test('stream: no keys yields CONFIG error', async () => {
  const adapter = makeAdapter({ keys: [] })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'sensenova',
    model: 'senseNova-6.8-flash-lite',
    messages: [{ role: 'user', content: 'hello' }],
  })) {
    chunks.push(chunk)
  }
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CONFIG')
})

test('stream: unknown key alias yields CONFIG error', async () => {
  const adapter = makeAdapter({})
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'sensenova',
    model: 'senseNova-6.8-flash-lite@k99',
    messages: [{ role: 'user', content: 'hello' }],
  })) {
    chunks.push(chunk)
  }
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CONFIG')
  assert.match(finish.reason.failure.message, /unknown key alias/)
})

test('stream: empty messages yields error', async () => {
  const adapter = makeAdapter({})
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'sensenova',
    model: 'senseNova-6.8-flash-lite',
    messages: [],
  })) {
    chunks.push(chunk)
  }
  // The adapter should still dispatch (empty messages → empty body), which
  // will fail because there's no fetch in the test. The dispatch will throw,
  // and the adapter will yield an error finish.
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish)
  assert.ok(finish.reason.kind === 'error' || finish.reason.kind === 'aborted')
})

// ── _poolStatus ────────────────────────────────────────────────────────────

test('_poolStatus: reports keys and aliases', () => {
  const adapter = makeAdapter({})
  const status = adapter._poolStatus()
  assert.equal(status.size, 2)
  assert.deepEqual(status.aliases, ['k1', 'k2'])
  assert.equal(status.masked.length, 2)
})

test('_poolStatus: empty keys', () => {
  const adapter = makeAdapter({ keys: [] })
  const status = adapter._poolStatus()
  assert.equal(status.size, 0)
  assert.deepEqual(status.aliases, [])
})

// ── index.js apply ─────────────────────────────────────────────────────────

test('index.js apply: registers adapter under both routes', async () => {
  const ctx = fakeContext({ inject: ['llm'], mounted: ['llm'] })

  // Dynamic import to pick up the latest source.
  const mod = await import('../index.js')
  const dispose = mod.apply(ctx, {})

  const llm = ctx.get('llm')
  assert.ok(llm)
  const captured = ctx.__captured
  assert.equal(captured.adapters.length, 1)
  assert.deepEqual(captured.adapters[0].routes, [ROUTE_PRIMARY, ROUTE_MULTI])
})
