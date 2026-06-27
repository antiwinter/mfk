import test from 'node:test';
import assert from 'node:assert/strict';
import {
  irFromMessagesToResponses,
  irFromResponsesToMessages,
} from '../src/lib/responsesConvert.js';

test('responses → messages: instructions become a system message', () => {
  const out = irFromResponsesToMessages({
    model: 'gpt-4.1',
    instructions: 'be concise',
    inputItems: [{ type: 'message', role: 'user', content: 'hi' }],
    messages: [],
    tools: null,
    previousResponseId: null,
  });

  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[0].content, 'be concise');
  assert.equal(out.messages[1].role, 'user');
});

test('responses → messages: text and image input items become user content blocks', () => {
  const out = irFromResponsesToMessages({
    model: 'gpt-4.1',
    inputItems: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this?' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,abc',
          },
        ],
      },
    ],
    messages: [],
    tools: null,
    previousResponseId: null,
  });

  assert.equal(out.messages.length, 1);
  const content = out.messages[0].content;
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 2);
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, 'what is this?');
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].data, 'abc');
});

test('responses → messages: function_call becomes a bracketed assistant message', () => {
  const out = irFromResponsesToMessages({
    model: 'gpt-4.1',
    inputItems: [
      { type: 'message', role: 'user', content: 'weather?' },
      {
        type: 'function_call',
        name: 'get_weather',
        arguments: '{"city":"Tokyo"}',
      },
      {
        type: 'function_call_output',
        output: 'sunny',
      },
    ],
    messages: [],
    tools: null,
    previousResponseId: null,
  });

  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[1].role, 'assistant');
  assert.match(out.messages[1].content, /function_call get_weather/);
  assert.equal(out.messages[2].role, 'user');
  assert.match(out.messages[2].content, /sunny/);
});

test('responses → messages: drops Responses-specific fields', () => {
  const out = irFromResponsesToMessages({
    model: 'gpt-4.1',
    inputItems: [{ type: 'message', role: 'user', content: 'hi' }],
    messages: [],
    instructions: 'be brief',
    tools: [{ type: 'function', name: 'x' }],
    previousResponseId: 'resp_1',
  });

  assert.equal(out.inputItems, null);
  assert.equal(out.instructions, null);
  assert.equal(out.tools, null);
  assert.equal(out.previousResponseId, null);
});

test('messages → responses: system messages fold into instructions', () => {
  const out = irFromMessagesToResponses({
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ],
    instructions: null,
    inputItems: null,
    tools: null,
    previousResponseId: null,
  });

  assert.equal(out.instructions, 'be brief');
  assert.equal(out.messages.length, 0);
  assert.equal(out.inputItems.length, 1);
  assert.equal(out.inputItems[0].role, 'user');
  assert.equal(out.inputItems[0].content, 'hi');
});

test('messages → responses: multiple system messages join with newlines', () => {
  const out = irFromMessagesToResponses({
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: 'rule one' },
      { role: 'system', content: 'rule two' },
      { role: 'user', content: 'hi' },
    ],
  });

  assert.equal(out.instructions, 'rule one\n\nrule two');
  assert.equal(out.inputItems.length, 1);
});

test('messages → responses: round-trip preserves user text', () => {
  const start = {
    model: 'gpt-4.1',
    instructions: 'be brief',
    inputItems: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ],
    messages: [],
    tools: null,
    previousResponseId: null,
  };

  const back = irFromMessagesToResponses(irFromResponsesToMessages(start));
  assert.equal(back.instructions, 'be brief');
  assert.equal(back.inputItems.length, 1);
  assert.equal(back.inputItems[0].role, 'user');
});
