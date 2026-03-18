import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVirtualKey } from '../src/lib/virtualKey.js';

test('parseVirtualKey extracts the username from a legacy virtual key', () => {
  const parsed = parseVirtualKey('Bearer sk-mfk-alice');

  assert.equal(parsed.token, 'sk-mfk-alice');
  assert.equal(parsed.username, 'alice');
});

test('parseVirtualKey extracts the username from a short virtual key', () => {
  const parsed = parseVirtualKey('Bearer mfk-bob');

  assert.equal(parsed.token, 'mfk-bob');
  assert.equal(parsed.username, 'bob');
});

test('parseVirtualKey works with x-api-key header', () => {
  const parsed = parseVirtualKey({ 'x-api-key': 'sk-mfk-alice' });

  assert.equal(parsed.token, 'sk-mfk-alice');
  assert.equal(parsed.username, 'alice');
});

test('parseVirtualKey rejects non-mfk tokens', () => {
  assert.throws(() => parseVirtualKey('Bearer sk-other-alice'), /Virtual key must start with sk-mfk-/);
});