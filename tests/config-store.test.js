import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildRuntimeProvider,
  DEFAULT_CONFIG_PATH,
  DEFAULT_DATABASE_PATH,
  resolveConfigPath,
  resolveDatabasePath,
  saveConfig,
} from '../src/config/store.js';

test('resolveConfigPath defaults to ~/.mfk/config.json', () => {
  assert.equal(resolveConfigPath(), DEFAULT_CONFIG_PATH);
});

test('resolveDatabasePath defaults to ~/.mfk/db.sqlite', () => {
  assert.equal(resolveDatabasePath('/tmp/project'), DEFAULT_DATABASE_PATH);
});

test('resolveDatabasePath expands a home-directory database path', () => {
  assert.equal(resolveDatabasePath('/tmp/project', '~/.mfk/custom.sqlite'), path.join(os.homedir(), '.mfk', 'custom.sqlite'));
});

test('saveConfig preserves an existing modelTier block from disk', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfk-config-'));
  const configPath = path.join(tempDir, 'config.json');

  await fs.writeFile(configPath, `${JSON.stringify({
    server: { host: '127.0.0.1', port: 8787 },
    database: { path: './db.sqlite' },
    modelTier: [['sonnet-4-6', 'qwen3.5-plus']],
    providers: {},
  }, null, 2)}\n`, 'utf8');

  await saveConfig(configPath, {
    server: { host: '127.0.0.1', port: 8787 },
    database: { path: './db.sqlite' },
    modelTier: [['ignored-at-runtime-save']],
    providers: [],
  });

  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(saved.modelTier, [['sonnet-4-6', 'qwen3.5-plus']]);
});

test('saveConfig does not invent a modelTier block when the file did not have one', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfk-config-'));
  const configPath = path.join(tempDir, 'config.json');

  await saveConfig(configPath, {
    server: { host: '127.0.0.1', port: 8787 },
    database: { path: './db.sqlite' },
    modelTier: [['runtime-only']],
    providers: [],
  });

  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal('modelTier' in saved, false);
});

test('saveConfig preserves normalized runtime providers instead of dropping them', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfk-config-'));
  const configPath = path.join(tempDir, 'config.json');

  const providerA = buildRuntimeProvider({
    apiKey: 'sk-provider-a',
    baseUrl: 'https://a.example.com',
    type: 'anthropic',
    models: ['anthropic/claude-sonnet-4-6'],
    order: 0,
  });
  const providerB = buildRuntimeProvider({
    apiKey: 'sk-provider-b',
    baseUrl: 'https://b.example.com',
    type: 'openai',
    models: ['qwen3.5-plus'],
    order: 1,
  });

  await saveConfig(configPath, {
    server: { host: '127.0.0.1', port: 8787 },
    database: { path: './db.sqlite' },
    modelTier: [],
    providers: [providerA, providerB],
  });

  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(Object.keys(saved.providers), ['sk-provider-a', 'sk-provider-b']);
  assert.equal(saved.providers['sk-provider-a'].url, 'https://a.example.com');
  assert.equal(saved.providers['sk-provider-b'].url, 'https://b.example.com');
});