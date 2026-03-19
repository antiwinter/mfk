# Test Guide

This repo has two test layers:

- Fast local unit tests for adapters, routing, config, auth, and DB behavior
- Live integration tests that hit real upstream providers through the local server

Use the smallest test slice that matches your change.

## Current Live Routing Map

Based on the current config in `mfk.config.json`:

- `anthropic/claude-sonnet-4-6` routes outbound to provider `1:anthropic`
- `qwen3.5-plus` routes outbound to provider `2:anthropic`

Inbound protocols supported by the local gateway:

- `openai`
- `anthropic`
- `google`

That means today:

- `openai` engine changes affect inbound adaptation only
- `google` engine changes affect inbound adaptation only
- `anthropic` engine changes affect both inbound adaptation and outbound provider calls

## Default Commands

Run all local tests:

```bash
npm test
```

Run live integration tests:

```bash
npm run test:integration
```

Run one exact live route:

```bash
npm run test:integration -- --inbound=anthropic --outbound=2 --model=qwen3.5-plus --mode=non-stream
```

Supported live filters:

- `--inbound=openai|anthropic|google`
- `--outbound=1|2|1:anthropic|2:anthropic|<provider-id>|<base-url>`
- `--model=<exact model>`
- `--mode=stream|non-stream`

## What To Run For Each Change

### Router or fallback logic changed

Run:

```bash
node --test tests/router.test.js tests/server-models.test.js tests/config-store.test.js
```

If the change can affect real routing selection, also run one live case per affected outbound provider:

```bash
npm run test:integration -- --outbound=1 --model=anthropic/claude-sonnet-4-6 --mode=non-stream
npm run test:integration -- --outbound=2 --model=qwen3.5-plus --mode=non-stream
```

### Stream handling changed

Do not rerun the full matrix first. Pick one stream and one non-stream case for each affected outbound provider.

Recommended smoke cases:

```bash
npm run test:integration -- --inbound=openai --outbound=1 --model=anthropic/claude-sonnet-4-6 --mode=stream
npm run test:integration -- --inbound=openai --outbound=1 --model=anthropic/claude-sonnet-4-6 --mode=non-stream
npm run test:integration -- --inbound=anthropic --outbound=2 --model=qwen3.5-plus --mode=stream
npm run test:integration -- --inbound=anthropic --outbound=2 --model=qwen3.5-plus --mode=non-stream
```

Use other inbound protocols only if the change is specific to them.

### `openai` engine changed

Run:

```bash
node --test tests/engine-openai.test.js tests/ir.test.js
```

Then run only OpenAI inbound live coverage:

```bash
npm run test:integration -- --inbound=openai --outbound=1 --model=anthropic/claude-sonnet-4-6 --mode=non-stream
```

If streaming code changed:

```bash
npm run test:integration -- --inbound=openai --outbound=1 --model=anthropic/claude-sonnet-4-6 --mode=stream
```

### `google` engine changed

Run:

```bash
node --test tests/engine-google.test.js tests/ir.test.js
```

Then run only Google inbound live coverage:

```bash
npm run test:integration -- --inbound=google --outbound=1 --model=anthropic/claude-sonnet-4-6 --mode=non-stream
```

If streaming code changed:

```bash
npm run test:integration -- --inbound=google --outbound=1 --model=anthropic/claude-sonnet-4-6 --mode=stream
```

### `anthropic` engine changed

This is the highest-impact engine in the current config because it is both an inbound protocol and the only outbound provider type.

Run:

```bash
node --test tests/engine-anthropic.test.js tests/ir.test.js
```

Then run at least:

```bash
npm run test:integration -- --inbound=anthropic --outbound=1 --model=anthropic/claude-sonnet-4-6 --mode=non-stream
npm run test:integration -- --inbound=anthropic --outbound=2 --model=qwen3.5-plus --mode=non-stream
```

If streaming code changed, rerun the same two with `--mode=stream`.

### Virtual key auth or DB changed

Run:

```bash
node --test tests/db-client.test.js tests/server-auth.test.js tests/virtualKey.test.js
```

If request entry/auth wiring changed, run one fast live case too:

```bash
npm run test:integration -- --inbound=openai --outbound=1 --model=anthropic/claude-sonnet-4-6 --mode=non-stream
```

### Config save/load changed

Run:

```bash
node --test tests/config-store.test.js tests/router.test.js tests/server-models.test.js
```

### Provider URL joining changed

Run:

```bash
node --test tests/providerUrl.test.js
```

Only add live integration if the change also touched actual request dispatch.

## If One Integration Route Fails

Do not rerun all combinations first.

Read the failing test label:

```text
integration: anthropic → 2:anthropic → qwen3.5-plus non-stream
```

Rerun exactly that route:

```bash
npm run test:integration -- --inbound=anthropic --outbound=2 --model=qwen3.5-plus --mode=non-stream
```

Then only widen scope if:

- the same engine handles multiple inbound protocols
- the same bug likely affects both stream and non-stream
- the same outbound provider is used by multiple models you changed

## When To Run The Full Live Matrix

Run the entire integration suite only when:

- server request wiring changed broadly
- router candidate selection changed broadly
- response translation changed across multiple engines
- you changed shared streaming behavior
- you are preparing to merge and want a final live confidence pass

Otherwise prefer filtered runs.