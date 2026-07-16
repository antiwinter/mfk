import test from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, lookupModelInfo, MODEL_CATALOG } from '../src/lib/modelInfo.js';

test('editDistance computes Levenshtein distance', () => {
  assert.equal(editDistance('', ''), 0);
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('abc', ''), 3);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('gpt-5.6-sol', 'gpt-5.6'), 4);
});

test('lookupModelInfo returns exact catalog entry', () => {
  const info = lookupModelInfo('claude-sonnet-4-6');
  assert.equal(info.id, 'claude-sonnet-4-6');
  assert.equal(info.contextWindow, 200000);
});

test('lookupModelInfo strips namespace and vendor suffixes before matching', () => {
  assert.equal(lookupModelInfo('anthropic/claude-opus-4-8').id, 'claude-opus-4-8');
  assert.equal(lookupModelInfo('deepseek-v4-pro-anthropic').id, 'deepseek-v4-pro');
  assert.equal(lookupModelInfo('glm-5.2-anthropic').id, 'glm-5.2');
  assert.equal(lookupModelInfo('qwen3.7-plus-anthropic').id, 'qwen3.7-plus');
});

test('lookupModelInfo matches a near-miss id to the closest family entry', () => {
  // Exact model absent; nearest is gpt-5.6, then gpt-5.5.
  assert.equal(lookupModelInfo('gpt-5.6-sol').id, 'gpt-5.6');
  assert.equal(lookupModelInfo('gpt-5.5-turbo').id, 'gpt-5.5');
});

test('lookupModelInfo returns null when nothing is close enough', () => {
  assert.equal(lookupModelInfo('totally-unknown-model-xyz'), null);
  assert.equal(lookupModelInfo('MiniMax-M3'), null);
  assert.equal(lookupModelInfo(''), null);
  assert.equal(lookupModelInfo(null), null);
});

test('MODEL_CATALOG entries have required shape', () => {
  for (const entry of MODEL_CATALOG) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(entry.id.length > 0);
    assert.equal(typeof entry.name, 'string');
    assert.ok(Array.isArray(entry.input));
    assert.ok(Number.isFinite(entry.contextWindow));
    assert.ok(Number.isFinite(entry.maxTokens));
    assert.ok(entry.cost && Number.isFinite(entry.cost.input));
  }
});
