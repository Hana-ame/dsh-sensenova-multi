# dsh-sensenova-multi

SenseNova multi-key provider for DeepSeek Harness. Registers `sensenova` and `sensenova-multi` routes with automatic API key rotation — 429/401/403 failures switch to the next key in the pool, with round-robin cooldown and per-key failure tracking.

## Setup

1. Copy the plugin directory to `~/.dsh/plugins/dsh-sensenova-multi/`
2. Edit `settings.json` — add your keys and set the endpoint:

```json
{
  "endpoint": "https://token.sensenova.cn",
  "path": "/v1/chat/completions",
  "keys": [
    "sk-51aU...",
    "sk-ANOTHER...",
    "sk-THIRD..."
  ],
  "timeoutMs": 120000,
  "cooldownMs": 60000,
  "listen": false,
  "defaultModel": "senseNova-6.8-flash-lite"
}
```

3. Restart DSH. The plugin registers on `inject: ['llm']`.

## Multi-key rotation

The adapter tries keys in round-robin order. On a retryable failure it switches to the next key:

| HTTP Status | Code          | Switch key? | Notes                          |
|-------------|---------------|-------------|--------------------------------|
| 429         | RATE_LIMIT    | yes         | quota/rate limit               |
| 401         | CREDENTIAL    | yes         | invalid/expired key            |
| 403         | FORBIDDEN     | yes         | insufficient scope             |
| 5xx         | SERVER        | yes         | endpoint broken for this key   |
| timeout     | TIMEOUT       | yes         | deadline expired               |
| 400         | CLIENT_ERROR  | **no**      | request defect; stop           |
| cancel      | ABORTED       | **no**      | caller cancelled; stop         |

A failed key enters cooldown (default 60s). A non-retryable error (400) cools the whole pool so the next turn doesn't burn N more refusals.

## Adapter contract (7 methods)

| # | Method                  | Implementation                                          |
|---|-------------------------|---------------------------------------------------------|
| 1 | `providerInfo`          | `{ id, name }` from `ROUTE_LABELS`                      |
| 2 | `providerRetryPolicy`   | `maxRetries: 0` — retries are internal to the adapter   |
| 3 | `imageRequestPricing`   | `undefined` — endpoint publishes no per-image price     |
| 4 | `listModels`            | static `MODEL_TABLE` from `catalog.js`                  |
| 5 | `resolveModel`          | model metadata with context window + max tokens         |
| 6 | `prepareCall`           | bind resolved model + one-shot `stream` closure         |
| 7 | `stream`                | translate → dispatch → rotate on retryable error → yield|

## Configuration

Edit `settings.json` in the plugin directory. Environment overrides:

| Env var              | Overrides      | Example                       |
|----------------------|----------------|-------------------------------|
| `SENSENOVA_ENDPOINT` | `endpoint`     | `https://token.sensenova.cn`  |
| `SENSENOVA_KEYS`     | `keys`         | `sk-abc,sk-def,sk-ghi`        |
| `SENSENOVA_TIMEOUT`  | `timeoutMs`    | `120000`                      |
| `SENSENOVA_COOLDOWN` | `cooldownMs`   | `60000`                       |
| `SENSENOVA_LISTEN`   | `listen`       | `1` or `true`                 |

Settings reload every 15 seconds without a restart.

## Forward listener

Set `"listen": true` to start an OpenAI-compatible proxy at `/v1/chat/completions`. External tools (curl, Python SDK) can then reach SenseNova models through DSH's key pool.

## Testing

```bash
cd ~/.dsh/plugins/dsh-sensenova-multi
node --test test/*.test.js
```

Tests cover key rotation (429 switch, 401 switch, all-fail error), error classification, key pool cooldown/round-robin, and adapter `listModels`/`resolveModel`/`prepareCall`.

## Models

| Model ID                  | Description                          | Context Window | Max Output |
|---------------------------|--------------------------------------|----------------|------------|
| `senseNova-6.8-flash-lite`| fast, low-latency chat (default)     | 131K           | 8K         |
| `senseNova-6.8-flash`     | balanced speed and quality           | 131K           | 8K         |
| `senseNova-6.8-pro`       | highest quality with extended reasoning | 262K         | 16K        |
| `senseNova-6.8-vision`    | multimodal with image understanding  | 131K           | 8K         |
| `senseNova-7.0-flash`     | next-gen fast model                  | 262K           | 16K        |
| `senseNova-7.0-pro`       | next-gen high quality                | 262K           | 16K        |
| `senseNova-7.2-flash`     | latest fast model                    | 262K           | 16K        |
| `senseNova-7.2-pro`       | latest high quality                  | 262K           | 32K        |
| `senseNova-7.2-vision`    | latest multimodal                    | 131K           | 16K        |

## Directory structure

```
dsh-sensenova-multi/
├── index.js              # entry: apply(ctx), registerAdapter
├── package.json
├── cordis.patch.yml      # bundle patch, inject=['llm']
├── catalog/
│   └── dsh-plugin.json   # catalog metadata
├── src/
│   ├── adapter.js        # 7-method LlmAdapter with rotation
│   ├── keys.js           # key pool: round-robin + cooldown
│   ├── errors.js         # error classification (429/401/403/5xx)
│   ├── catalog.js        # static model table
│   ├── settings.js       # settings.json load/validate/env override
│   ├── upstream.js       # HTTP dispatch with Bearer auth
│   ├── stream.js         # SSE parse → DSH StreamChunks
│   └── forward.js        # OpenAI-compatible proxy listener
├── test/
│   ├── fake-kernel.mjs   # test scaffolding
│   ├── keys.test.js      # key rotation tests
│   └── adapter.test.js   # adapter method tests
└── settings.json         # default config (edit me!)
```

## License

MIT
