import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/app.js';
import { loadConfig, resolveDatabasePath } from '../src/config/store.js';
import { createDatabase } from '../src/db/client.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Uses the real mfk.config.json — no synthetic config or env vars.
let _server;
async function getServer() {
  if (_server) return _server;
  const { config, dir } = await loadConfig();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfk-integ-'));
  const db = createDatabase(path.join(tmpDir, 'test.sqlite'));
  const app = createServer({ config, db });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  _server = { app, db, baseUrl };
  return _server;
}

test.after(async () => {
  if (_server) {
    await _server.app.close();
    _server.db.close();
  }
});

const VKEY = 'mfk-test';
const PROMPT = 'Reply with only the word "pong".';
const MAX_TOKENS = 16;
const MODELS = ['anthropic/claude-sonnet-4-6', 'qwen3.5-plus'];

// --- SSE collectors per inbound protocol ---

// Read a streaming response chunk-by-chunk and return { chunks, events, text }.
// `extractText` turns a parsed SSE data object into a text string (or '').
async function readStream(res, extractText) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let chunks = 0;
  let buffer = '';
  let text = '';
  let events = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks++;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const d = JSON.parse(payload);
        events++;
        text += extractText(d);
      } catch {}
    }
  }
  return { chunks, events, text };
}

const sseExtractors = {
  openai:    (d) => d?.choices?.[0]?.delta?.content ?? '',
  anthropic: (d) => (d.type === 'content_block_delta' ? d.delta?.text ?? '' : ''),
  google:    (d) => d?.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
};

// --- Request builders ---

function openaiReq(baseUrl, model, stream) {
  return [`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS, stream }),
  }];
}

function anthropicReq(baseUrl, model, stream) {
  return [`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': VKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS, stream }),
  }];
}

function googleReq(baseUrl, model, stream) {
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  // Strip namespace prefix (e.g. anthropic/) — slashes break the path param
  const urlModel = model.replace(/^[^/]+\//, '');
  return [`${baseUrl}/v1beta/models/${encodeURIComponent(urlModel)}:${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${VKEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: MAX_TOKENS } }),
  }];
}

// --- Assertions per inbound protocol ---

async function assertOpenAi(res, stream) {
  assert.equal(res.status, 200, `openai status: ${res.status}`);
  if (!stream) {
    const d = await res.json();
    assert.equal(d.object, 'chat.completion');
    assert.ok(d.choices[0].message.content.length > 0, 'should have content');
  } else {
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const { events, text } = await readStream(res, sseExtractors.openai);
    assert.ok(events >= 1, `should receive SSE events, got ${events}`);
    assert.ok(text.length > 0, `should have streamed content, got: "${text}"`);
  }
}

async function assertAnthropic(res, stream) {
  assert.equal(res.status, 200, `anthropic status: ${res.status}`);
  if (!stream) {
    const d = await res.json();
    assert.equal(d.type, 'message');
    const textBlock = d.content.find((b) => b.type === 'text');
    assert.ok(textBlock?.text?.length > 0, 'should have text content');
  } else {
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const { events, text } = await readStream(res, sseExtractors.anthropic);
    assert.ok(events >= 1, `should receive SSE events, got ${events}`);
    assert.ok(text.length > 0, `should have streamed content, got: "${text}"`);
  }
}

async function assertGoogle(res, stream) {
  assert.equal(res.status, 200, `google status: ${res.status}`);
  if (!stream) {
    const d = await res.json();
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'should have content');
  } else {
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const { events, text } = await readStream(res, sseExtractors.google);
    assert.ok(events >= 1, `should receive SSE events, got ${events}`);
    assert.ok(text.length > 0, `should have streamed content, got: "${text}"`);
  }
}

// --- 3 inbound × 2 models × 2 modes = 12 tests ---

const INBOUNDS = [
  { name: 'openai',    req: openaiReq,    assert: assertOpenAi },
  { name: 'anthropic', req: anthropicReq, assert: assertAnthropic },
  { name: 'google',    req: googleReq,    assert: assertGoogle },
];

// Model as outer loop: test all inbound protocols for each model before moving
// on, so that failover-induced key disables don't affect later models.
for (const model of MODELS) {
  for (const inbound of INBOUNDS) {
    for (const stream of [false, true]) {
      const label = `${inbound.name} → ${model} ${stream ? 'stream' : 'non-stream'}`;
      test(`integration: ${label}`, { timeout: 30_000 }, async () => {
        const { baseUrl } = await getServer();
        const [url, opts] = inbound.req(baseUrl, model, stream);
        const res = await fetch(url, opts);
        await inbound.assert(res, stream);
      });
    }
  }
}
