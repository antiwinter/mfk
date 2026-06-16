import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../src/config/store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfk-test-'));
  store = new ConfigStore(path.join(tmpDir, 'config.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ConfigStore - providers', () => {
  it('adds a provider and assigns a short key', () => {
    const key = store.addProvider({ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-123' });
    expect(key).toBeTruthy();
    expect(key.length).toBe(5);
    const p = store.getProvider(key);
    expect(p).toBeDefined();
    expect(p.name).toBe('OpenAI');
  });

  it('resolves provider by short key', () => {
    const key = store.addProvider({ name: 'Test', baseUrl: 'https://test.com', apiKey: 'sk-abc' });
    const p = store.resolveProvider(key);
    expect(p).toBeDefined();
    expect(p.shortKey).toBe(key);
  });

  it('resolves provider by full api key', () => {
    store.addProvider({ name: 'Test', baseUrl: 'https://test.com', apiKey: 'sk-fullkey-xyz' });
    const p = store.resolveProvider('sk-fullkey-xyz');
    expect(p).toBeDefined();
    expect(p.name).toBe('Test');
  });

  it('resolves provider by index', () => {
    store.addProvider({ name: 'First', baseUrl: 'https://first.com', apiKey: 'sk-1' });
    store.addProvider({ name: 'Second', baseUrl: 'https://second.com', apiKey: 'sk-2' });
    const p = store.resolveProvider(0);
    expect(p).toBeDefined();
    expect(p.name).toBe('First');
  });

  it('returns undefined for unknown provider', () => {
    const p = store.resolveProvider('zzzzz');
    expect(p).toBeUndefined();
  });

  it('lists providers with short keys', () => {
    store.addProvider({ name: 'A', baseUrl: 'https://a.com', apiKey: 'sk-a' });
    store.addProvider({ name: 'B', baseUrl: 'https://b.com', apiKey: 'sk-b' });
    const list = store.listProviders();
    expect(list.length).toBe(2);
    expect(list[0].shortKey).toBeDefined();
    expect(list[1].shortKey).toBeDefined();
  });
});

describe('ConfigStore - rules', () => {
  it('adds a rule with provider short key', () => {
    const providerKey = store.addProvider({ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-123' });
    store.addRule({ alias: 'gpt4', provider: providerKey, model: 'gpt-4' });
    const rules = store.listRules();
    expect(rules.length).toBe(1);
    expect(rules[0].alias).toBe('gpt4');
    expect(rules[0].provider).toBe(providerKey);
  });

  it('resolves rule provider to short key', () => {
    const providerKey = store.addProvider({ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-123' });
    store.addRule({ alias: 'gpt4', provider: 'sk-123', model: 'gpt-4' });
    const rules = store.listRules();
    // provider stored as-is, but resolveProvider should work
    const p = store.resolveProvider(rules[0].provider);
    expect(p).toBeDefined();
    expect(p.shortKey).toBe(providerKey);
  });
});
