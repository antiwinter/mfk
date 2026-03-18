import test from 'node:test';
import assert from 'node:assert/strict';
import { createIR, createDelta, createMessage, collectEvents, flattenMessageContent, collectSystemPrompt } from '../src/ir.js';

test('createIR produces a valid IR object', () => {
  const ir = createIR({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.7,
    maxTokens: 100,
    stream: true,
  });

  assert.equal(ir.model, 'gpt-4');
  assert.equal(ir.messages.length, 1);
  assert.equal(ir.temperature, 0.7);
  assert.equal(ir.maxTokens, 100);
  assert.equal(ir.stream, true);
});

test('createDelta creates a delta event', () => {
  const delta = createDelta('hello');
  assert.deepEqual(delta, { type: 'delta', text: 'hello' });
});

test('createMessage creates a message event with defaults', () => {
  const msg = createMessage({ content: 'hi' });
  assert.equal(msg.type, 'message');
  assert.equal(msg.content, 'hi');
  assert.equal(msg.finishReason, 'stop');
  assert.equal(msg.usage.inputTokens, 0);
  assert.equal(msg.usage.outputTokens, 0);
});

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
