import test from 'node:test';
import assert from 'node:assert/strict';
import { googleEngine } from '../src/engines/google.js';

test('google parseReq normalizes a Google request body to IR', () => {
  const ir = googleEngine.parseReq(
    {
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hi' }] },
      ],
      generationConfig: { temperature: 0.5, maxOutputTokens: 100 },
      systemInstruction: { role: 'system', parts: [{ text: 'Be brief.' }] },
    },
    { model: 'gemini-pro', stream: false },
  );

  assert.equal(ir.model, 'gemini-pro');
  assert.equal(ir.messages.length, 3);
  assert.equal(ir.messages[0].role, 'system');
  assert.equal(ir.messages[0].content, 'Be brief.');
  assert.equal(ir.messages[1].role, 'user');
  assert.equal(ir.messages[2].role, 'assistant');
  assert.equal(ir.temperature, 0.5);
  assert.equal(ir.maxTokens, 100);
});

test('google endpoint produces correct path with API key', () => {
  const ir = { model: 'gemini-pro', stream: false };
  const key = { value: 'test-key' };
  const path = googleEngine.endpoint(ir, key);
  assert.match(path, /v1beta\/models\/gemini-pro:generateContent/);
  assert.match(path, /key=test-key/);
});

test('google buildReq produces correct body', () => {
  const ir = {
    model: 'gemini-pro',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  };
  const body = googleEngine.buildReq(ir);
  assert.equal(body.contents.length, 1);
  assert.equal(body.contents[0].role, 'user');
  assert.deepEqual(body.contents[0].parts, [{ text: 'hi' }]);
});

test('google buildReq preserves multimodal parts', () => {
  const ir = {
    model: 'gemini-pro',
    messages: [
      {
        role: 'user',
        content: [
          { text: 'Describe this image.' },
          { inlineData: { mimeType: 'image/png', data: 'abc123' } },
        ],
      },
    ],
    stream: false,
  };

  const body = googleEngine.buildReq(ir);
  assert.deepEqual(body.contents[0].parts, [
    { text: 'Describe this image.' },
    { inlineData: { mimeType: 'image/png', data: 'abc123' } },
  ]);
});

test('google parseReq preserves multimodal parts', () => {
  const ir = googleEngine.parseReq({
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Describe this image.' },
          { inlineData: { mimeType: 'image/png', data: 'abc123' } },
        ],
      },
    ],
  }, { model: 'gemini-pro', stream: false });

  assert.deepEqual(ir.messages[0].content, [
    { type: 'text', text: 'Describe this image.' },
    { type: 'image', mediaType: 'image/png', data: 'abc123' },
  ]);
});

test('google endpoint uses streamGenerateContent for streaming', () => {
  const ir = { model: 'gemini-pro', stream: true };
  const key = { value: 'test-key' };
  const path = googleEngine.endpoint(ir, key);
  assert.match(path, /streamGenerateContent/);
  assert.match(path, /alt=sse/);
});

test('google buildRes creates a Google response', () => {
  const res = googleEngine.buildRes({
    content: 'hello!',
    finishReason: 'stop',
    usage: { inputTokens: 5, outputTokens: 2 },
  });

  assert.equal(res.candidates[0].content.parts[0].text, 'hello!');
  assert.equal(res.candidates[0].content.role, 'model');
  assert.equal(res.usageMetadata.promptTokenCount, 5);
  assert.equal(res.usageMetadata.candidatesTokenCount, 2);
});

test('google parse handles a JSON (non-stream) response', async () => {
  const body = JSON.stringify({
    candidates: [
      {
        content: { parts: [{ text: 'hi there' }], role: 'model' },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
  });

  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const events = [];
  for await (const event of googleEngine.parse(response, 'http://test')) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message');
  assert.equal(events[0].content, 'hi there');
});
