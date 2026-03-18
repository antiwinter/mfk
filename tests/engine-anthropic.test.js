import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicEngine } from '../src/engines/anthropic.js';

test('anthropic parseReq normalizes an Anthropic request body to IR', () => {
  const ir = anthropicEngine.parseReq({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hi' }],
    system: 'Be helpful.',
    max_tokens: 1024,
    temperature: 0.7,
    stream: false,
  });

  assert.equal(ir.model, 'claude-sonnet-4-6');
  assert.equal(ir.messages.length, 2);
  assert.equal(ir.messages[0].role, 'system');
  assert.equal(ir.messages[0].content, 'Be helpful.');
  assert.equal(ir.messages[1].role, 'user');
  assert.equal(ir.maxTokens, 1024);
  assert.equal(ir.stream, false);
});

test('anthropic parseReq strips anthropic/ prefix from model', () => {
  const ir = anthropicEngine.parseReq({
    model: 'anthropic/claude-sonnet-4-6',
    messages: [],
    max_tokens: 100,
  });

  assert.equal(ir.model, 'claude-sonnet-4-6');
});

test('anthropic parseReq flattens content block arrays', () => {
  const ir = anthropicEngine.parseReq({
    model: 'test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'line1' },
          { type: 'text', text: 'line2' },
        ],
      },
    ],
    max_tokens: 100,
  });

  assert.equal(ir.messages[0].content, 'line1\nline2');
});

test('anthropic endpoint returns messages path', () => {
  assert.equal(anthropicEngine.endpoint(), '/v1/messages');
});

test('anthropic buildHeaders produces correct authorization', () => {
  const provider = { baseUrl: 'https://api.anthropic.com', headers: {} };
  const key = { value: 'sk-ant-test' };
  const headers = anthropicEngine.buildHeaders(provider, key);
  assert.equal(headers['x-api-key'], 'sk-ant-test');
  assert.match(headers['anthropic-version'], /^\d{4}-\d{2}-\d{2}$/);
});

test('anthropic buildReq produces correct body', () => {
  const ir = {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
    ],
    maxTokens: 1024,
    stream: false,
  };
  const body = anthropicEngine.buildReq(ir);
  assert.equal(body.system, 'Be brief.');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
});

test('anthropic buildRes creates an Anthropic message response', () => {
  const res = anthropicEngine.buildRes({
    content: 'hello!',
    model: 'claude-sonnet-4-6',
    finishReason: 'end_turn',
    usage: { inputTokens: 5, outputTokens: 2 },
  });

  assert.equal(res.type, 'message');
  assert.equal(res.role, 'assistant');
  assert.equal(res.content[0].type, 'text');
  assert.equal(res.content[0].text, 'hello!');
  assert.equal(res.stop_reason, 'end_turn');
  assert.equal(res.usage.input_tokens, 5);
  assert.equal(res.usage.output_tokens, 2);
});

test('anthropic parse handles a JSON (non-stream) response', async () => {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'hi there' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
  });

  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const events = [];
  for await (const event of anthropicEngine.parse(response, 'http://test')) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message');
  assert.equal(events[0].content, 'hi there');
  assert.equal(events[0].finishReason, 'end_turn');
  assert.equal(events[0].usage.inputTokens, 3);
});
