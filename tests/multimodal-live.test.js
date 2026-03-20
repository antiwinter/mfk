import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadConfig } from '../src/config/store.js';
import { createServer } from '../src/server/app.js';

const RUN_MULTIMODAL = process.env.MFK_TEST_MULTIMODAL === '1';
const IMAGE_BASE64 = await fs.readFile(new URL('./test.png', import.meta.url), 'base64');
const { config } = await loadConfig();
const VKEY = 'mfk-0123456789abcdef01234567';

function createDb() {
  return {
    findVirtualKeyByToken(token) {
      if (token === VKEY) {
        return { alias: 'multimodal-test', virtual_key: token };
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

const CASES = [
  { model: 'anthropic/claude-sonnet-4-6', label: 'sonnet-4-6' },
  { model: 'qwen3.5-plus', label: 'qwen3.5-plus' },
];

for (const testCase of CASES) {
  test(`multimodal live: ${testCase.label}`, { skip: !RUN_MULTIMODAL }, async () => {
    const app = createServer({ config, db: createDb() });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${VKEY}`,
          'content-type': 'application/json',
        },
        payload: {
        model: testCase.model,
          max_tokens: 128,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${IMAGE_BASE64}`,
                  },
                },
                {
                  type: 'text',
                  text: 'What animal is shown, and what is it eating?',
                },
              ],
            },
          ],
        },
      });

      assert.equal(response.statusCode, 200, response.body);

      const payload = response.json();
      const visibleText = payload?.choices?.[0]?.message?.content?.trim?.() ?? '';

      assert.ok(visibleText.length > 0, `Expected visible text for ${testCase.model}`);

      console.log(`${testCase.model}: ${visibleText}`);
      console.log(`${testCase.model} usage: ${JSON.stringify(payload.usage ?? {})}`);
    } finally {
      await app.close();
    }
  });
}