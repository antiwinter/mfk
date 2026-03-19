import test from 'node:test';
import assert from 'node:assert/strict';
import { createIR, createDelta, createMessage, collectEvents, flattenMessageContent, collectSystemPrompt } from '../src/ir.js';

test('collectEvents accumulates deltas into message content', async () => {
  async function* gen() {
    yield createDelta('hel');
    yield createDelta('lo');
    yield createMessage({ content: '', model: 'test', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } });
  }

  const msg = await collectEvents(gen());
  assert.equal(msg.content, 'hello');
  assert.equal(msg.model, 'test');
  assert.equal(msg.usage.inputTokens, 5);
});

test('collectEvents returns message even without deltas', async () => {
  async function* gen() {
    yield createMessage({ content: 'full response', model: 'x' });
  }

  const msg = await collectEvents(gen());
  assert.equal(msg.content, 'full response');
});

test('flattenMessageContent handles strings', () => {
  assert.equal(flattenMessageContent('hello'), 'hello');
});

test('flattenMessageContent handles content block arrays', () => {
  const result = flattenMessageContent([
    { type: 'text', text: 'line1' },
    { type: 'text', text: 'line2' },
  ]);
  assert.equal(result, 'line1\nline2');
});

test('collectSystemPrompt extracts system messages', () => {
  const messages = [
    { role: 'system', content: 'Be helpful.' },
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'Be concise.' },
  ];
  assert.equal(collectSystemPrompt(messages), 'Be helpful.\n\nBe concise.');
});
