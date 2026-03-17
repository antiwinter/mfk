# mfk

`mfk` is a local HTTP gateway and CLI for routing LLM requests across multiple upstream providers and API keys.

## Features

- Reads providers, models, and routing policy from a JSON config file keyed by upstream API key.
- Routes by model, with optional explicit provider selection using the `provider` request field or `x-mfk-provider` header.
- Uses priority-based failover across keys and providers.
- Applies cooldown policies for quota failures and other retryable failures.
- Accepts local virtual keys in the format `sk-mfk-<username>` and writes request logs to SQLite.
- Provides Commander-based CLI commands for `serve`, `test`, and `add`.

## Install

```bash
npm install
```

## Configuration

The default config file is `mfk.config.json`.

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "database": {
    "path": "./mfk.sqlite"
  },
  "providers": {
    "your-secret": {
      "url": "https://api.anthropic.com",
      "type": "anthropic",
      "models": ["claude-sonnet-4-5"]
    }
  }
}
```

Provider order is the routing priority. The first provider entry has the highest priority.

Default values are omitted from the saved config:

- `quotaReset` defaults to `daily`
- `failureReset` defaults to `hourly`

Provider `type` values:

- `openai-compatible`
- `anthropic`
- `google`

Policy values:

- `quotaReset`: `daily` or `monthly`
- `failureReset`: `next_try`, `hourly`, or `daily`

## Commands

Start the local gateway:

```bash
mfk serve
```

Test a provider and list available models. `providerRef` can be the 1-based provider index, the provider URL, or the exact API key:

```bash
mfk test 1
```

Add a provider by base URL and key. `mfk` auto-detects the API style in priority order: `anthropic`, `openai-compatible`, then `google`.

```bash
mfk add localhost:11434 my-secret-key
```

## Local API

The local gateway exposes an OpenAI-style endpoint at `/v1/chat/completions`.

Use a virtual key in the form `sk-mfk-<username>`:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer sk-mfk-alice' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-4-5",
    "provider": "1",
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

Notes:

- `provider` is optional. If omitted, `mfk` picks the highest-priority provider that advertises the requested model.
- Streaming is not implemented in this version.
- Request attempts are recorded in SQLite at the configured database path.