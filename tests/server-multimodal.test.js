import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/app.js';

const VKEY = 'mfk-0123456789abcdef01234567';

function createProvider() {
  return {
    id: 'anthropic-provider',
    apiKey: 'sk-upstream',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.example.com',
    order: 0,
    priority: 0,
    quotaReset: 'daily',
    failureReset: 'hourly',
    headers: {},
    models: ['anthropic/claude-sonnet-4-6'],
    key: {
      name: 'anthropic-provider',
      value: 'sk-upstream',
      priority: 0,
    },
  };
}

function createDb() {
  return {
    findVirtualKeyByToken(token) {
      if (token === VKEY) {
        return { alias: 'alice', virtual_key: token };
      }

      return null;
    },
    getKeyState() {
      return null;
    },
    markSuccess() {},
    markFailure() {},
    logRequest() {},
  };
}

test('openai multimodal request is forwarded to anthropic provider with image content intact', async (t) => {
  const originalFetch = globalThis.fetch;
  const captured = [];

  globalThis.fetch = async (url, options = {}) => {
    captured.push({ url: String(url), options });
    return new Response(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'A panda eating bamboo.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const app = createServer({
    config: {
      providers: [createProvider()],
      modelTier: [],
      server: {},
      database: {},
    },
    db: createDb(),
  });

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      authorization: `Bearer ${VKEY}`,
      'content-type': 'application/json',
    },
    payload: {
      model: 'anthropic/claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
          ],
        },
      ],
      max_tokens: 64,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(captured.length, 1);
  const upstreamBody = JSON.parse(captured[0].options.body);
  assert.deepEqual(upstreamBody.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
        },
      ],
    },
  ]);
});