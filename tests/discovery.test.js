import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProbeModels } from '../src/engines/discovery.js';

test('selectProbeModels falls back to a known model when discovery returns none', () => {
  const models = selectProbeModels([], 'qwen3.5-plus');

  assert.deepEqual(models, ['qwen3.5-plus']);
});

test('selectProbeModels includes a known model alongside discovered models', () => {
  const models = selectProbeModels(['claude-sonnet-4-5'], 'qwen3.5-plus');

  assert.deepEqual(models, ['claude-sonnet-4-5', 'qwen3.5-plus']);
});

test('selectProbeModels ignores wildcard entries', () => {
  const models = selectProbeModels(['anthropic/*', 'qwen3.5-plus'], null);

  assert.deepEqual(models, ['qwen3.5-plus']);
});