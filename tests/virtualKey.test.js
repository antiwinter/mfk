import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVirtualKeyToken } from '../src/lib/virtualKey.js';

test('extractVirtualKeyToken extracts a bearer token', () => {
  const token = extractVirtualKeyToken('Bearer mfk-abcdef1234567890abcdef12');

  assert.equal(token, 'mfk-abcdef1234567890abcdef12');
});

test('extractVirtualKeyToken works with x-api-key header', () => {
  const token = extractVirtualKeyToken({ 'x-api-key': 'mfk-abcdef1234567890abcdef12' });

  assert.equal(token, 'mfk-abcdef1234567890abcdef12');
});

test('extractVirtualKeyToken rejects malformed bearer headers', () => {
  assert.throws(() => extractVirtualKeyToken('Basic something'), /Authorization header must use Bearer authentication/);
});

test('extractVirtualKeyToken rejects missing headers', () => {
  assert.throws(() => extractVirtualKeyToken({}), /Missing authentication header/);
});