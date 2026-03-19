import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveConfig } from '../src/config/store.js';

test('saveConfig preserves an existing modelTier block from disk', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfk-config-'));
  const configPath = path.join(tempDir, 'mfk.config.json');

  await fs.writeFile(configPath, `${JSON.stringify({
    server: { host: '127.0.0.1', port: 8787 },
    database: { path: './mfk.sqlite' },
    modelTier: [['sonnet-4-6', 'qwen3.5-plus']],
    providers: {},
  }, null, 2)}\n`, 'utf8');

  await saveConfig(configPath, {
    server: { host: '127.0.0.1', port: 8787 },
    database: { path: './mfk.sqlite' },
    modelTier: [['ignored-at-runtime-save']],
    providers: [],
  });

  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(saved.modelTier, [['sonnet-4-6', 'qwen3.5-plus']]);
});

test('saveConfig does not invent a modelTier block when the file did not have one', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfk-config-'));
  const configPath = path.join(tempDir, 'mfk.config.json');

  await saveConfig(configPath, {
    server: { host: '127.0.0.1', port: 8787 },
    database: { path: './mfk.sqlite' },
    modelTier: [['runtime-only']],
    providers: [],
  });

  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal('modelTier' in saved, false);
});