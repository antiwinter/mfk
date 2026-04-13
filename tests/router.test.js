import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates } from '../src/router.js';

function createProvider({
  id,
  order,
  type = 'anthropic',
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

function createDb(states = {}) {
  return {
    getKeyState(keyName) {
      return states[keyName] ?? null;
    },
  };
}

test('selectCandidates keeps exact model matches ahead of tier fallback', () => {
  const config = {
    modelTier: [
      ['opus-4-6'],
      ['sonnet-4-6', 'qwen3.5-plus'],
    ],
    providers: [
      createProvider({ id: 'anthropic', order: 0, models: ['anthropic/claude-sonnet-4-6'] }),
      createProvider({ id: 'dashscope', order: 1, models: ['qwen3.5-plus'] }),
    ],
  };

  const candidates = selectCandidates(config, createDb(), { model: 'qwen3.5-plus' });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].provider.id, 'dashscope');
  assert.equal(candidates[0].model, 'qwen3.5-plus');
  assert.equal(candidates[0].tierDistance, 0);
});

test('selectCandidates ignores disabled_until while provider cooldowns are disabled', () => {
  const config = {
    modelTier: [
      ['opus-4-6'],
      ['sonnet-4-6', 'qwen3.5-plus'],
      ['haiku-4-5'],
    ],
    providers: [
      createProvider({ id: 'anthropic', order: 0, models: ['anthropic/claude-sonnet-4-6'] }),
      createProvider({ id: 'dashscope', order: 1, models: ['qwen3.5-plus'] }),
    ],
  };
  const db = createDb({
    'dashscope-key': {
      disabled_until: '2999-01-01T00:00:00.000Z',
    },
  });

  const candidates = selectCandidates(config, db, { model: 'qwen3.5-plus' });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].provider.id, 'dashscope');
  assert.equal(candidates[0].model, 'qwen3.5-plus');
  assert.equal(candidates[0].tierDistance, 0);
});

test('selectCandidates chooses the closest adjacent tier when no same-tier model is available', () => {
  const config = {
    modelTier: [
      ['opus-4-6'],
      ['sonnet-4-6'],
      ['haiku-4-5'],
    ],
    providers: [
      createProvider({ id: 'stronger', order: 1, models: ['anthropic/claude-opus-4-6'] }),
      createProvider({ id: 'weaker', order: 0, models: ['anthropic/claude-haiku-4-5'] }),
    ],
  };

  const candidates = selectCandidates(config, createDb(), { model: 'sonnet-4-6' });

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].provider.id, 'stronger');
  assert.equal(candidates[0].model, 'anthropic/claude-opus-4-6');
  assert.equal(candidates[0].tierDistance, 1);
  assert.equal(candidates[1].provider.id, 'weaker');
  assert.equal(candidates[1].tierDistance, 1);
});

test('selectCandidates does not cross-provider fallback when an explicit provider is requested', () => {
  const config = {
    modelTier: [
      ['sonnet-4-6', 'qwen3.5-plus'],
    ],
    providers: [
      createProvider({ id: 'anthropic', order: 0, models: ['anthropic/claude-sonnet-4-6'] }),
      createProvider({ id: 'dashscope', order: 1, models: ['qwen3.5-plus'] }),
    ],
  };

  const candidates = selectCandidates(config, createDb(), { model: 'qwen3.5-plus', provider: '1' });

  assert.deepEqual(candidates, []);
});

test('selectCandidates matches a plain model request against a namespaced provider model by terminal name', () => {
  const config = {
    modelTier: [],
    providers: [
      createProvider({ id: 'anthropic', order: 0, models: ['anthropic/claude-sonnet-4-6'] }),
    ],
  };

  const candidates = selectCandidates(config, createDb(), { model: 'claude-sonnet-4-6' });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].provider.id, 'anthropic');
  assert.equal(candidates[0].model, 'anthropic/claude-sonnet-4-6');
});

test('selectCandidates matches terminal model names across different path prefixes', () => {
  const config = {
    modelTier: [],
    providers: [
      createProvider({ id: 'prefixed', order: 0, models: ['baz/bar'] }),
    ],
  };

  const candidates = selectCandidates(config, createDb(), { model: 'foo/bar' });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].provider.id, 'prefixed');
  assert.equal(candidates[0].model, 'baz/bar');
});