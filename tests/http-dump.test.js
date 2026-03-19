import test from 'node:test';
import assert from 'node:assert/strict';
import { createDumpOptions, emitDumpError, emitDumpRequestLine, emitDumpResponse, finalizeDump } from '../src/lib/http.js';

function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-9;]*m/g, '');
}

test('dump emits request and response lines with one-line normalization and truncation', () => {
  const output = [];
  const dump = createDumpOptions({
    enabled: true,
    columns: 120,
    write(text) {
      output.push(text);
    },
  });

  emitDumpRequestLine(dump, {
    requestedModel: 'qwen3.5-plus',
    selectedModel: 'anthropic/claude-sonnet-4-6',
    selectedKeyValue: 'sk-1234567890abcdef',
    promptChars: 15500,
    promptText: 'hello\nworld this prompt should be truncated heavily',
  });
  emitDumpResponse(dump, 'pong\nreply text should also be truncated independently');
  finalizeDump(dump, {
    inputTokens: 18000,
    outputTokens: 368,
  });

  const rendered = stripAnsi(output.join(''));
  assert.equal(rendered, '-> qwen3.5-plus (sk-1234...cdef/anthropic/claude-sonnet-4-6) hello world this prompt should be truncated heavily [15.5k]\n<< pong reply text should also be truncated independently [18k↑, 368↓]\n');
});

test('dump renders failures with status plus truncated message', () => {
  const output = [];
  const dump = createDumpOptions({
    enabled: true,
    columns: 120,
    write(text) {
      output.push(text);
    },
  });

  emitDumpRequestLine(dump, {
    requestedModel: 'qwen3.5-plus',
    promptChars: 5,
    promptText: 'hello',
  });
  emitDumpError(dump, 'auth_error', 'Unknown\nvirtual key and a very long message that should be truncated');
  finalizeDump(dump);

  assert.equal(stripAnsi(output.join('')), '-> qwen3.5-plus (-/qwen3.5-plus) hello [5]\n<< auth_error Unknown virtual key and a very long message that should be truncated\n');
});