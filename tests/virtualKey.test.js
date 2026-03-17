import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVirtualKey } from '../src/lib/virtualKey.js';

test('parseVirtualKey extracts the username from a local virtual key', () => {
  const parsed = parseVirtualKey('Bearer sk-mfk-alice');

  assert.equal(parsed.token, 'sk-mfk-alice');
  assert.equal(parsed.username, 'alice');
});

test('parseVirtualKey rejects non-mfk tokens', () => {
  assert.throws(() => parseVirtualKey('Bearer sk-other-alice'), /Virtual key must start with sk-mfk-/);
});