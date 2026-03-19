import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiEngine } from '../src/engines/openai.js';

test('openai parseReq normalizes an OpenAI request body to IR', () => {
  const ir = openaiEngine.parseReq({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.5,
    max_tokens: 100,
    stream: false,
  });

  assert.equal(ir.model, 'gpt-4');
  assert.equal(ir.messages.length, 1);
  assert.equal(ir.temperature, 0.5);
  assert.equal(ir.maxTokens, 100);
  assert.equal(ir.stream, false);
});

test('openai parseReq prefers max_completion_tokens over max_tokens', () => {
  const ir = openaiEngine.parseReq({
    model: 'gpt-4',
    messages: [],
    max_completion_tokens: 200,
    max_tokens: 100,
  });

  assert.equal(ir.maxTokens, 200);
});

test('openai buildHeaders produces correct authorization', () => {
  const provider = { baseUrl: 'https://api.openai.com', headers: {} };
  const key = { value: 'sk-test' };
  const headers = openaiEngine.buildHeaders(provider, key);
  assert.equal(headers.authorization, 'Bearer sk-test');
  assert.equal(headers['content-type'], 'application/json');
});

test('openai buildReq produces correct body', () => {
  const ir = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: false };
  const body = openaiEngine.buildReq(ir);
  assert.equal(body.model, 'gpt-4');
  assert.equal(body.stream, false);
});

test('openai buildReq includes stream_options when streaming', () => {
  const ir = { model: 'gpt-4', messages: [], stream: true };
  const body = openaiEngine.buildReq(ir);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('openai buildRes creates a chat.completion response', () => {
  const res = openaiEngine.buildRes({
    content: 'hello!',
    model: 'gpt-4',
    finishReason: 'stop',
    usage: { inputTokens: 5, outputTokens: 2 },
  });

  assert.equal(res.object, 'chat.completion');
  assert.equal(res.choices[0].message.content, 'hello!');
  assert.equal(res.choices[0].finish_reason, 'stop');
  assert.equal(res.usage.prompt_tokens, 5);
  assert.equal(res.usage.completion_tokens, 2);
  assert.equal(res.usage.total_tokens, 7);
});

test('openai parse handles a JSON (non-stream) response', async () => {
  const body = JSON.stringify({
    model: 'gpt-4',
    choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });

  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const events = [];
  for await (const event of openaiEngine.parse(response, 'http://test')) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message');
  assert.equal(events[0].content, 'hi');
  assert.equal(events[0].usage.inputTokens, 3);
});
