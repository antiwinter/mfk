import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/app.js';

function createDb(virtualKeyRecord = null) {
  return {
    findVirtualKeyByToken(token) {
      if (virtualKeyRecord?.virtual_key === token) {
        return virtualKeyRecord;
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

test('completion endpoints reject unknown virtual keys', async (t) => {
  const app = createServer({
    config: { providers: [], modelTier: [], server: {}, database: {} },
    db: createDb(),
  });

  t.after(() => app.close());

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

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.message, 'Unknown virtual key');
});

test('completion endpoints accept stored virtual keys and continue routing', async (t) => {
  const app = createServer({
    config: { providers: [], modelTier: [], server: {}, database: {} },
    db: createDb({ alias: 'alice', virtual_key: 'mfk-0123456789abcdef01234567' }),
  });

  t.after(() => app.close());

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

  assert.equal(response.statusCode, 404);
  assert.match(response.json().error.message, /No provider is configured/);
});