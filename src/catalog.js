/**
 * Static model catalog for the SenseNova provider.
 *
 * The endpoint `https://token.sensenova.cn` is an OpenAI-compatible gateway
 * that serves the SenseNova model family. The catalog below is the static list
 * of models the picker should show; it is deliberately conservative — a model
 * we have not verified costs the user a 404, while an omission costs only a
 * picker that stops short of answering.
 *
 * `listModels` is advisory, not request validation: the harness's router
 * accepts unlisted model ids, and a user who knows a model name can still
 * address it. The catalog exists so the GUI picker has something to show and
 * so `resolveModel` can return accurate context-window metadata.
 *
 * @module src/catalog.js
 */

/** Provider route ids this adapter publishes. */
export const ROUTE_PRIMARY = 'sensenova'
export const ROUTE_MULTI = 'sensenova-multi'

/** Display names for the picker. */
export const ROUTE_LABELS = {
  [ROUTE_PRIMARY]: 'SenseNova',
  [ROUTE_MULTI]: 'SenseNova · multi-key',
}

/** Default context window for models without a specific entry. */
export const DEFAULT_CONTEXT_WINDOW = 131_072

/** Default max output tokens. */
export const DEFAULT_MAX_TOKENS = 8_192

/**
 * The static model table. Each row is an `LlmModelInfo` extended with the
 * context window and default max tokens `resolveModel` needs.
 *
 * @type {Array<{id: string, name: string, description: string, contextWindow: number, maxOutput: number, vision: boolean}>}
 */
export const MODEL_TABLE = [
  {
    id: 'senseNova-6.8-flash-lite',
    name: 'SenseNova 6.8 Flash Lite',
    description: 'fast, low-latency chat model — the default route for interactive use',
    contextWindow: 131_072,
    maxOutput: 8_192,
    vision: false,
  },
  {
    id: 'senseNova-6.8-flash',
    name: 'SenseNova 6.8 Flash',
    description: 'balanced speed and quality for general chat',
    contextWindow: 131_072,
    maxOutput: 8_192,
    vision: false,
  },
  {
    id: 'senseNova-6.8-pro',
    name: 'SenseNova 6.8 Pro',
    description: 'highest quality generation with extended reasoning',
    contextWindow: 262_144,
    maxOutput: 16_384,
    vision: false,
  },
  {
    id: 'senseNova-6.8-vision',
    name: 'SenseNova 6.8 Vision',
    description: 'multimodal model with image understanding',
    contextWindow: 131_072,
    maxOutput: 8_192,
    vision: true,
  },
  {
    id: 'senseNova-7.0-flash',
    name: 'SenseNova 7.0 Flash',
    description: 'next-generation fast model with improved reasoning',
    contextWindow: 262_144,
    maxOutput: 16_384,
    vision: false,
  },
  {
    id: 'senseNova-7.0-pro',
    name: 'SenseNova 7.0 Pro',
    description: 'highest quality next-generation model',
    contextWindow: 262_144,
    maxOutput: 16_384,
    vision: false,
  },
  {
    id: 'senseNova-7.2-flash',
    name: 'SenseNova 7.2 Flash',
    description: 'latest fast model with improved efficiency',
    contextWindow: 262_144,
    maxOutput: 16_384,
    vision: false,
  },
  {
    id: 'senseNova-7.2-pro',
    name: 'SenseNova 7.2 Pro',
    description: 'latest high-quality model with extended reasoning',
    contextWindow: 262_144,
    maxOutput: 32_768,
    vision: false,
  },
  {
    id: 'senseNova-7.2-vision',
    name: 'SenseNova 7.2 Vision',
    description: 'latest multimodal model with image understanding',
    contextWindow: 131_072,
    maxOutput: 16_384,
    vision: true,
  },
]

/** Default model for the provider. */
export const DEFAULT_MODEL = 'senseNova-6.8-flash-lite'

/** Default key alias when none is specified in the model name. */
export const DEFAULT_KEY_ALIAS = 'k1'

/** Look up a model by id, returning a clone so callers can mutate safely. */
export function findModel(id) {
  const row = MODEL_TABLE.find(m => m.id === id)
  if (row === undefined) return null
  return { ...row }
}

/**
 * Build the `LlmModelInfo[]` that `listModels` returns.
 *
 * When a key pool is provided, each model is listed once per key alias
 * (e.g. `senseNova-6.8-flash-lite@k1`, `senseNova-6.8-flash-lite@k2`).
 * This lets the model picker show one entry per key, so the user can select
 * which key to bind their session to.
 *
 * @param {string} provider - the provider route this list is for.
 * @param {string[]} [aliases] - key aliases to list (e.g. `['k1','k2']`).
 *   When omitted or empty, lists models without key suffixes.
 * @returns {Array<object>} LlmModelInfo rows.
 */
export function catalogRows(provider, aliases) {
  const hasKeys = Array.isArray(aliases) && aliases.length > 0
  const rows = []

  for (const row of MODEL_TABLE) {
    if (hasKeys) {
      for (const alias of aliases) {
        rows.push({
          provider,
          id: `${row.id}@${alias}`,
          name: `${row.name} · ${alias}`,
          description: `${row.description} — key ${alias}`,
          inputModalities: row.vision ? ['text', 'image'] : ['text'],
        })
      }
    } else {
      rows.push({
        provider,
        id: row.id,
        name: row.name,
        description: row.description,
        inputModalities: row.vision ? ['text', 'image'] : ['text'],
      })
    }
  }
  return rows
}

/**
 * Parse a model name that may contain a `@key` suffix.
 *
 * @param {string} model - the model name.
 * @returns {{modelId: string, alias: string | null}}
 */
export function parseModelKey(model) {
  const s = String(model ?? '')
  const atIndex = s.lastIndexOf('@')
  if (atIndex < 0) return { modelId: s, alias: null }
  const modelId = s.slice(0, atIndex)
  const alias = s.slice(atIndex + 1)
  return { modelId, alias: alias !== '' ? alias : null }
}

/**
 * Build the resolved model info for `resolveModel`.
 *
 * @param {string} provider - the provider route.
 * @param {string} model - the model id (may include `@key` suffix).
 * @returns {object | null} LlmResolvedModelInfo, or null when the id is unknown.
 */
export function resolveModelInfo(provider, model) {
  const { modelId, alias } = parseModelKey(model)
  const row = findModel(modelId)
  if (row === null) return null
  return {
    provider,
    id: model,
    name: alias ? `${row.name} · ${alias}` : row.name,
    description: row.description,
    inputModalities: row.vision ? ['text', 'image'] : ['text'],
    context: { contextWindow: row.contextWindow },
    defaultMaxTokens: row.maxOutput,
  }
}
