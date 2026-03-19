import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/app.js';

function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-9;]*m/g, '');
}

function createProvider() {
  return {
    id: 'openai-provider',
    apiKey: 'sk-upstream',
    type: 'openai',
    baseUrl: 'https://api.openai.example.com',
    order: 0,
    priority: 0,
    quotaReset: 'daily',
    failureReset: 'hourly',
    headers: {},
    models: ['qwen3.5-plus'],
    key: {
      name: 'openai-provider',
      value: 'sk-upstream',
      priority: 0,
    },
  };
}

function createDb() {
  return {
    findVirtualKeyByToken(token) {
      if (token === 'mfk-0123456789abcdef01234567') {
        return {
          alias: 'alice',
          virtual_key: token,
        };
      }

      return null;
    },
    getKeyState() {
      return null;
    },
    markSuccess() {},
    markFailure() {},
    logRequest() {},
  };
}

test('server dump emits one formatted line and request logging still records DB-shaped rows', async (t) => {
  const dumpOutput = [];
  const requestLogs = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'chatcmpl_test',
    object: 'chat.completion',
    model: 'qwen3.5-plus',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'pong' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const app = createServer({
    config: {
      providers: [createProvider()],
      modelTier: [],
      server: {},
      database: {},
    },
    db: createDb(),
    dump: true,
    dumpWrite(text) {
      dumpOutput.push(text);
    },
    onRequestLog(record) {
      requestLogs.push(record);
    },
  });

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      authorization: 'Bearer mfk-0123456789abcdef01234567',
      'content-type': 'application/json',
    },
    payload: {
      model: 'qwen3.5-plus',
      messages: [{ role: 'user', content: 'hello' }],
    },
  });

  assert.equal(response.statusCode, 200);
  const output = stripAnsi(dumpOutput.join(''));
  assert.equal(output, '-> qwen3.5-plus (sk-upst...ream/qwen3.5-plus) hello [5]\n<< pong [12 ↑, 4 ↓]\n');
  assert.equal(requestLogs.length, 1);
  assert.equal(requestLogs[0].alias, 'alice');
  assert.equal(requestLogs[0].request_model, 'qwen3.5-plus');
  assert.equal(requestLogs[0].selected_key, 'openai-provider');
  assert.equal(requestLogs[0].status, 'success');
  assert.equal(requestLogs[0].input_tokens, 12);
  assert.equal(requestLogs[0].output_tokens, 4);
});