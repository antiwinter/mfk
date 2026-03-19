import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDumpLine } from '../src/lib/http.js';

function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-9;]*m/g, '');
}

test('formatDumpLine normalizes text to one line and truncates prompt and response independently', () => {
  const line = stripAnsi(formatDumpLine({
    requestedModel: 'qwen3.5-plus',
    selectedModel: 'anthropic/claude-sonnet-4-6',
    selectedKeyValue: 'sk-1234567890abcdef',
    promptChars: 15500,
    promptText: 'hello\nworld this prompt should be truncated heavily',
    responseText: 'pong\nreply text should also be truncated independently',
    inputTokens: 18000,
    outputTokens: 368,
    status: 'success',
  }, 120));

  assert.ok(!line.includes('\n'));
  assert.match(line, /^-> 15\.5k qwen3\.5-plus \(sk-1234\.\.\.cdef\/anthropic\/claude-sonnet-4-6\) /);
  assert.match(line, /hello world this \.\.\./);
  assert.match(line, / << pong reply text s\.\.\./);
  assert.match(line, /\[18k ↑, 368 ↓\]$/);
});

test('formatDumpLine renders failures with status plus truncated message', () => {
  const line = stripAnsi(formatDumpLine({
    requestedModel: 'qwen3.5-plus',
    promptChars: 5,
    promptText: 'hello',
    status: 'auth_error',
    errorType: 'auth_error',
    errorMessage: 'Unknown\nvirtual key and a very long message that should be truncated',
  }, 120));

  assert.equal(line, '-> 5 qwen3.5-plus (-/qwen3.5-plus) hello << auth_error Unknown virtual k...');
});