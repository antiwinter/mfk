import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server/app.js';

const VKEY = 'mfk-0123456789abcdef01234567';

function createAnthropicProvider() {
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
    models: ['claude-sonnet-4-6'],
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

test('anthropic same-protocol requests pass through tools and tool_use blocks unchanged', async (t) => {
  const originalFetch = globalThis.fetch;
  const captured = [];
  const upstreamResponse = {
    id: 'msg_tool',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_123',
        name: 'search_docs',
        input: { query: 'same protocol passthrough' },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 17,
      output_tokens: 9,
    },
  };

  globalThis.fetch = async (url, options = {}) => {
    captured.push({ url: String(url), options });
    return new Response(JSON.stringify(upstreamResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const app = createServer({
    config: {
      providers: [createAnthropicProvider()],
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

  const payload = {
    model: 'claude-sonnet-4-6',
    tools: [
      {
        name: 'search_docs',
        description: 'Search local docs',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ],
    tool_choice: { type: 'auto' },
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Search the docs for passthrough mode.' }],
      },
    ],
    max_tokens: 128,
  };

  const response = await app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: {
      'x-api-key': VKEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    payload,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://api.anthropic.example.com/v1/messages');
  assert.equal(captured[0].options.headers['x-api-key'], 'sk-upstream');
  assert.deepEqual(JSON.parse(captured[0].options.body), payload);
  assert.deepEqual(response.json(), upstreamResponse);
});

test('anthropic same-protocol streaming responses are forwarded unchanged', async (t) => {
  const originalFetch = globalThis.fetch;
  const streamBody = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"search_docs","input":{}}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
  ].join('');

  globalThis.fetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(streamBody));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    },
  );

  const app = createServer({
    config: {
      providers: [createAnthropicProvider()],
      modelTier: [],
      server: {},
      database: {},
    },
    db: createDb(),
  });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
  });

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Use the docs tool.' }],
      },
    ],
    max_tokens: 128,
    stream: true,
  });

  const response = await requestHttp(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': VKEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
    body: payload,
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/event-stream/);
  assert.equal(response.body, streamBody);
});

function requestHttp(url, options) {
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    const request = http.request({
      method: options.method,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: options.headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    request.on('error', reject);
    request.end(options.body);
  });
}
