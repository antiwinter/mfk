import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderUrl } from '../src/lib/http.js';

test('buildProviderUrl appends a versioned endpoint to a plain host base', () => {
  const url = buildProviderUrl('https://api.openai.com', '/v1/models');

  assert.equal(url, 'https://api.openai.com/v1/models');
});

test('buildProviderUrl avoids duplicating overlapping version segments', () => {
  const url = buildProviderUrl('https://dashscope.aliyuncs.com/compatible-mode/v1', '/v1/chat/completions');

  assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
});

test('buildProviderUrl preserves non-version prefixes when appending endpoints', () => {
  const url = buildProviderUrl('https://example.com/apps/anthropic', '/v1/models');

  assert.equal(url, 'https://example.com/apps/anthropic/v1/models');
});

test('buildProviderUrl avoids duplicating google v1beta bases', () => {
  const url = buildProviderUrl('https://generativelanguage.googleapis.com/v1beta', '/v1beta/models?key=test-key');

  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models?key=test-key');
});