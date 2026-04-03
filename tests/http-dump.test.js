import test from 'node:test';
import assert from 'node:assert/strict';
import { createDump, emitError, emitRequest, emitResponse, finalize } from '../src/lib/dump.js';

function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-9;]*m/g, '');
}

test('dump emits request and response lines with one-line normalization and truncation', () => {
  const output = [];
  const dump = createDump({
    enabled: true,
    columns: 120,
    write(text) {
      output.push(text);
    },
  });

  emitRequest(dump, {
    requestedModel: 'qwen3.5-plus',
    selectedModel: 'anthropic/claude-sonnet-4-6',
    selectedKeyValue: 'sk-1234567890abcdef',
    promptChars: 15500,
    promptText: 'hello\nworld this prompt should be truncated heavily',
  });
  emitResponse(dump, 'pong\nreply text should also be truncated independently');
  finalize(dump, {
    inputTokens: 18000,
    outputTokens: 368,
  });

  const rendered = stripAnsi(output.join(''));
  assert.equal(rendered, '-> qwen3.5-plus (sk-1234...cdef/anthropic/claude-sonnet-4-6) hello world this prompt should be truncated heavily [15.5k]\n<< pong reply text should also be truncated independently [18k↑, 368↓]\n');
});

test('dump renders failures with status plus truncated message', () => {
  const output = [];
  const dump = createDump({
    enabled: true,
    columns: 120,
    write(text) {
      output.push(text);
    },
  });

  emitRequest(dump, {
    requestedModel: 'qwen3.5-plus',
    promptChars: 5,
    promptText: 'hello',
  });
  emitError(dump, 'auth_error', 'Unknown\nvirtual key and a very long message that should be truncated');
  finalize(dump);

  assert.equal(stripAnsi(output.join('')), '-> qwen3.5-plus (-/qwen3.5-plus) hello [5]\n<< auth_error Unknown virtual key and a very long message that should be truncated\n');
});