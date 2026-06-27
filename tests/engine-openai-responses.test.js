import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiResponsesEngine } from '../src/engines/openaiResponses.js';
import { createDelta, createMessage } from '../src/ir.js';

test('openai-responses apiStyle is responses', () => {
  assert.equal(openaiResponsesEngine.type, 'openai');
  assert.equal(openaiResponsesEngine.apiStyle, 'responses');
});

test('openai-responses endpoint is /v1/responses', () => {
  assert.equal(openaiResponsesEngine.endpoint(), '/v1/responses');
});

test('openai-responses canBypassTo accepts openai providers', () => {
  assert.equal(openaiResponsesEngine.canBypassTo({ type: 'openai' }), true);
  assert.equal(openaiResponsesEngine.canBypassTo({ type: 'anthropic' }), false);
});

test('openai-responses parseReq reads string input as a user message', () => {
  const ir = openaiResponsesEngine.parseReq({
    model: 'gpt-4.1',
    input: 'hello',
    temperature: 0.3,
    max_output_tokens: 64,
  });

  assert.equal(ir.model, 'gpt-4.1');
  assert.equal(ir.temperature, 0.3);
  assert.equal(ir.maxTokens, 64);
  assert.equal(ir.inputItems, null);
  assert.equal(ir.messages.length, 1);
  assert.equal(ir.messages[0].role, 'user');
  assert.equal(ir.messages[0].content, 'hello');
});

test('openai-responses parseReq reads array input into inputItems', () => {
  const ir = openaiResponsesEngine.parseReq({
    model: 'gpt-4.1',
    input: [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'assistant', content: 'hello' },
    ],
  });

  assert.equal(ir.inputItems.length, 2);
  assert.equal(ir.inputItems[0].role, 'user');
  assert.equal(ir.inputItems[1].role, 'assistant');
});

test('openai-responses parseReq preserves instructions, tools, and previous_response_id', () => {
  const ir = openaiResponsesEngine.parseReq({
    model: 'gpt-4.1',
    input: 'hi',
    instructions: 'be concise',
    tools: [{ type: 'function', name: 'foo' }],
    previous_response_id: 'resp_abc',
  });

  assert.equal(ir.instructions, 'be concise');
  assert.deepEqual(ir.tools, [{ type: 'function', name: 'foo' }]);
  assert.equal(ir.previousResponseId, 'resp_abc');
});

test('openai-responses parseReq prefers max_output_tokens over max_tokens', () => {
  const ir = openaiResponsesEngine.parseReq({
    model: 'gpt-4.1',
    input: 'x',
    max_output_tokens: 50,
    max_tokens: 10,
  });
  assert.equal(ir.maxTokens, 50);
});

test('openai-responses buildHeaders produces correct authorization', () => {
  const headers = openaiResponsesEngine.buildHeaders(
    { baseUrl: 'https://api.openai.com', headers: {} },
    { value: 'sk-test' },
  );
  assert.equal(headers.authorization, 'Bearer sk-test');
  assert.equal(headers['content-type'], 'application/json');
});

test('openai-responses buildReq emits Responses wire shape from inputItems', () => {
  const ir = openaiResponsesEngine.parseReq({
    model: 'gpt-4.1',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    instructions: 'be brief',
    max_output_tokens: 32,
  });

  const body = openaiResponsesEngine.buildReq(ir);

  assert.equal(body.model, 'gpt-4.1');
  assert.equal(body.instructions, 'be brief');
  assert.equal(body.max_output_tokens, 32);
  assert.equal(Array.isArray(body.input), true);
  assert.equal(body.input[0].role, 'user');
});

test('openai-responses buildReq falls back to messages when inputItems is empty', () => {
  const ir = {
    model: 'gpt-4.1',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    inputItems: null,
    stream: false,
  };

  const body = openaiResponsesEngine.buildReq(ir);
  assert.equal(Array.isArray(body.input), true);
  assert.equal(body.input.length, 2);
  assert.equal(body.input[0].role, 'user');
  assert.equal(body.input[1].role, 'assistant');
});

test('openai-responses buildReq omits optional fields when not set', () => {
  const ir = {
    model: 'gpt-4.1',
    messages: [{ role: 'user', content: 'hi' }],
    inputItems: null,
    instructions: null,
    tools: null,
    previousResponseId: null,
    stream: false,
  };
  const body = openaiResponsesEngine.buildReq(ir);
  assert.equal('instructions' in body, false);
  assert.equal('tools' in body, false);
  assert.equal('previous_response_id' in body, false);
});

test('openai-responses buildRes creates a response-shaped JSON', () => {
  const res = openaiResponsesEngine.buildRes({
    content: 'hello',
    model: 'gpt-4.1',
    finishReason: 'stop',
    usage: { inputTokens: 4, outputTokens: 2 },
  });

  assert.equal(res.object, 'response');
  assert.equal(res.status, 'completed');
  assert.equal(res.output[0].role, 'assistant');
  assert.equal(res.output[0].content[0].type, 'output_text');
  assert.equal(res.output[0].content[0].text, 'hello');
  assert.equal(res.usage.input_tokens, 4);
  assert.equal(res.usage.output_tokens, 2);
  assert.equal(res.usage.total_tokens, 6);
});

test('openai-responses parse handles a JSON (non-stream) response', async () => {
  const body = JSON.stringify({
    model: 'gpt-4.1',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hi there' }],
      },
    ],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });

  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const events = [];
  for await (const event of openaiResponsesEngine.parse(response, 'http://test')) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message');
  assert.equal(events[0].content, 'hi there');
  assert.equal(events[0].usage.inputTokens, 3);
  assert.equal(events[0].usage.outputTokens, 2);
});

test('openai-responses parse handles SSE streaming output_text deltas', async () => {
  const sse = [
    'event: response.created\n',
    'data: {"type":"response.created","response":{"model":"gpt-4.1","status":"in_progress"}}\n',
    '\n',
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":"hello"}\n',
    '\n',
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":" world"}\n',
    '\n',
    'event: response.completed\n',
    `data: {"type":"response.completed","response":{"model":"gpt-4.1","status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n`,
    '\n',
    'data: [DONE]\n\n',
  ].join('');

  const response = new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  const events = [];
  for await (const event of openaiResponsesEngine.parse(response, 'http://test')) {
    events.push(event);
  }

  const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text);
  assert.deepEqual(deltas, ['hello', ' world']);

  const finalMessage = events.find((e) => e.type === 'message');
  assert.ok(finalMessage, 'expected a final message event');
  assert.equal(finalMessage.model, 'gpt-4.1');
  assert.equal(finalMessage.usage.inputTokens, 4);
  assert.equal(finalMessage.usage.outputTokens, 2);
});

test('openai-responses writeStream includes accumulated text in final SSE events', async () => {
  const chunks = [];
  const reply = {
    raw: {
      setHeader() {},
      write(chunk) {
        chunks.push(chunk);
      },
      end() {},
    },
    hijack() {},
  };

  async function* events() {
    yield createDelta('hello');
    yield createDelta(' world');
    yield createMessage({ content: '', model: 'gpt-4.1' });
  }

  await openaiResponsesEngine.writeStream(reply, events(), { model: 'gpt-4.1' });

  const sseEvents = parseSseEvents(chunks.join(''));
  const outputTextDone = sseEvents.find((event) => event.event === 'response.output_text.done').data;
  const contentPartDone = sseEvents.find((event) => event.event === 'response.content_part.done').data;
  const outputItemDone = sseEvents.find((event) => event.event === 'response.output_item.done').data;
  const completed = sseEvents.find((event) => event.event === 'response.completed').data;

  assert.equal(outputTextDone.text, 'hello world');
  assert.equal(contentPartDone.part.text, 'hello world');
  assert.equal(outputItemDone.item.content[0].text, 'hello world');
  assert.equal(completed.response.output[0].content[0].text, 'hello world');
});

function parseSseEvents(raw) {
  return raw.trim().split('\n\n').map((event) => {
    const lines = event.split('\n');
    return {
      event: lines.find((line) => line.startsWith('event: ')).slice('event: '.length),
      data: JSON.parse(lines.find((line) => line.startsWith('data: ')).slice('data: '.length)),
    };
  });
}
