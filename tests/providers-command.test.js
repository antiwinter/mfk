import test from 'node:test';
import assert from 'node:assert/strict';
import { findProvider, formatProviderKey } from '../src/config/store.js';
import {
  formatProviderLine,
  formatProviderStatus,
  formatProviderUrl,
} from '../src/cli/commands/providers.js';

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '');
}

test('formatProviderStatus renders live for missing cooldown state', () => {
  assert.equal(stripAnsi(formatProviderStatus(null)), 'live');
});

test('formatProviderStatus renders cooldown hours with millify', () => {
  const state = { disabled_until: '2026-03-25T08:30:00.000Z' };
  const rendered = formatProviderStatus(state, new Date('2026-03-25T06:30:00.000Z'));

  assert.equal(stripAnsi(rendered), 'CD 2h');
});

test('formatProviderUrl truncates long domains to 16 characters including ellipsis', () => {
  assert.equal(formatProviderUrl('https://coding.dashscope.aliyuncs.com/apps/anthropic'), 'coding.dashsc...');
});

test('formatProviderKey renders the last 6 characters of the API key', () => {
  assert.equal(formatProviderKey('sk-49qf79jMD4AKU4xcm1HG6A'), 'm1HG6A');
});

test('formatProviderLine includes domain, provider key, status, and note', () => {
  const provider = {
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-49qf79jMD4AKU4xcm1HG6A',
    key: { name: 'api-anthropic-com-abcd' },
  };
  const state = {
    disabled_until: '2026-03-25T07:30:00.000Z',
    last_error: 'Premature close',
  };

  const rendered = formatProviderLine(provider, state, new Date('2026-03-25T06:30:00.000Z'));

  assert.equal(stripAnsi(rendered), 'm1HG6A\tCD 1h\tapi.anthropic.com\tPremature close');
});

test('findProvider matches the displayed short key', () => {
  const config = {
    providers: [
      {
        apiKey: 'sk-49qf79jMD4AKU4xcm1HG6A',
        baseUrl: 'http://llm.intchains.in:9000',
        id: 'llm-intchains-in-9000-hg6a',
      },
    ],
  };

  const provider = findProvider(config, 'm1HG6A');

  assert.equal(provider?.apiKey, 'sk-49qf79jMD4AKU4xcm1HG6A');
});

test('findProvider supports partial matching and rejects ambiguity', () => {
  const config = {
    providers: [
      {
        apiKey: 'sk-49qf79jMD4AKU4xcm1HG6A',
        baseUrl: 'http://llm.intchains.in:9000',
        id: 'llm-intchains-in-9000-hg6a',
      },
      {
        apiKey: 'sk-sp-65117f5d4715499aaf1a6652ca1599b0',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
        id: 'coding-dashscope-aliyuncs-com-99b0',
      },
    ],
  };

  assert.equal(findProvider(config, 'intchains')?.id, 'llm-intchains-in-9000-hg6a');
  assert.throws(() => findProvider(config, 'sk-'), /Ambiguous provider selector/);
});