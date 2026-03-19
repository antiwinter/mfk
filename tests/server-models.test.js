import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/app.js';

function createProvider({
  id,
  order,
  type,
  models,
}) {
  return {
    id,
    apiKey: `${id}-key`,
    type,
    baseUrl: `https://${id}.example.com`,
    order,
    priority: order,
    quotaReset: 'daily',
    failureReset: 'hourly',
    headers: {},
    models,
    key: {
      name: `${id}-key`,
      value: `${id}-secret`,
      priority: order,
    },
  };
}

function createDb() {
  return {
    getKeyState() {
      return null;
    },
    markSuccess() {},
    markFailure() {},
    logRequest() {},
  };
}

test('GET /v1/models returns the full local capability set from config', async (t) => {
  const app = createServer({
    config: {
      modelTier: [['sonnet-4-6', 'qwen3.5-plus']],
      providers: [
        createProvider({ id: 'anthropic', order: 0, type: 'anthropic', models: ['anthropic/*', 'anthropic/claude-sonnet-4-6'] }),
        createProvider({ id: 'dashscope', order: 1, type: 'anthropic', models: ['qwen3.5-plus'] }),
      ],
    },
    db: createDb(),
  });

  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/models',
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.data.map((entry) => entry.id), [
    'anthropic/claude-sonnet-4-6',
    'qwen3.5-plus',
  ]);
});

test('GET /v1/models strips anthropic namespace for anthropic clients', async (t) => {
  const app = createServer({
    config: {
      modelTier: [['sonnet-4-6', 'qwen3.5-plus']],
      providers: [
        createProvider({ id: 'anthropic', order: 0, type: 'anthropic', models: ['anthropic/claude-sonnet-4-6'] }),
        createProvider({ id: 'dashscope', order: 1, type: 'anthropic', models: ['qwen3.5-plus'] }),
      ],
    },
    db: createDb(),
  });

  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: {
      'x-api-key': 'sk-test',
      'anthropic-version': '2023-06-01',
    },
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.data.map((entry) => entry.id), [
    'claude-sonnet-4-6',
    'qwen3.5-plus',
  ]);
});

test('GET /v1beta/models returns the same local capability set', async (t) => {
  const app = createServer({
    config: {
      modelTier: [['sonnet-4-6', 'qwen3.5-plus']],
      providers: [
        createProvider({ id: 'anthropic', order: 0, type: 'anthropic', models: ['anthropic/claude-sonnet-4-6'] }),
        createProvider({ id: 'dashscope', order: 1, type: 'anthropic', models: ['qwen3.5-plus'] }),
      ],
    },
    db: createDb(),
  });

  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1beta/models',
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.models.map((entry) => entry.name), [
    'models/anthropic/claude-sonnet-4-6',
    'models/qwen3.5-plus',
  ]);
});