import test from 'node:test';
import assert from 'node:assert/strict';
import { probeProviderModel, selectProbeModels } from '../src/engines/discovery.js';

test('selectProbeModels falls back to a known model when discovery returns none', () => {
  const models = selectProbeModels([], 'qwen3.5-plus');

  assert.deepEqual(models, ['qwen3.5-plus']);
});

test('selectProbeModels uses last model alphabetically from discovered models', () => {
  const models = selectProbeModels(['claude-sonnet-4-5'], 'qwen3.5-plus');

  assert.deepEqual(models, ['qwen3.5-plus']);
});

test('selectProbeModels ignores wildcard entries', () => {
  const models = selectProbeModels(['anthropic/*', 'qwen3.5-plus'], null);

  assert.deepEqual(models, ['qwen3.5-plus']);
});

test('probeProviderModel prints request line first and streams response on the second line', async () => {
  const originalFetch = globalThis.fetch;
  const output = [];

  globalThis.fetch = async () => new Response([
    'data: {"id":"chatcmpl_test","model":"qwen3.5-plus","choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl_test","model":"qwen3.5-plus","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n',
    'data: [DONE]\n\n',
  ].join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  try {
    await probeProviderModel({
      type: 'openai',
      baseUrl: 'https://api.openai.example.com',
      headers: {},
    }, {
      value: 'sk-sp-b1aa60b8967b4a4fa16b9694a2202952',
    }, 'qwen3.5-plus', {
      echo: {
        enabled: true,
        columns: 120,
        write(text) {
          output.push(text);
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rendered = String(output.join('')).replace(/\x1B\[[0-9;]*m/g, '');
  assert.equal(rendered, '-> qwen3.5-plus (sk-sp-b...2952/qwen3.5-plus) hello, tell me yo... [30]\n<< pong [12 ↑, 4 ↓]\n');
});

test('probeProviderModel replaces streamed newlines with spaces instead of joining words', async () => {
  const originalFetch = globalThis.fetch;
  const output = [];

  globalThis.fetch = async () => new Response([
    'data: {"id":"chatcmpl_test","model":"qwen3.5-plus","choices":[{"delta":{"content":"I am Gemini,\\n"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl_test","model":"qwen3.5-plus","choices":[{"delta":{"content":"a large language model\\ntrained by Google."},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl_test","model":"qwen3.5-plus","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n',
    'data: [DONE]\n\n',
  ].join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  try {
    await probeProviderModel({
      type: 'openai',
      baseUrl: 'https://api.openai.example.com',
      headers: {},
    }, {
      value: 'sk-sp-b1aa60b8967b4a4fa16b9694a2202952',
    }, 'qwen3.5-plus', {
      echo: {
        enabled: true,
        columns: 160,
        write(text) {
          output.push(text);
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rendered = String(output.join('')).replace(/\x1B\[[0-9;]*m/g, '');
  assert.equal(rendered, '-> qwen3.5-plus (sk-sp-b...2952/qwen3.5-plus) hello, tell me your model name [30]\n<< I am Gemini, a large language model trained by Google. [12 ↑, 4 ↓]\n');
});