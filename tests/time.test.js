import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNextBoundary, isCooldownActive } from '../src/lib/time.js';

test('computeNextBoundary returns the next hour boundary', () => {
  const result = computeNextBoundary('hourly', new Date('2026-03-16T12:34:56.000Z'));
  assert.equal(result, '2026-03-16T13:00:00.000Z');
});

test('computeNextBoundary returns the next day boundary', () => {
  const result = computeNextBoundary('daily', new Date('2026-03-16T12:34:56.000Z'));
  assert.equal(result, '2026-03-17T00:00:00.000Z');
});

test('computeNextBoundary returns the next month boundary', () => {
  const result = computeNextBoundary('monthly', new Date('2026-03-16T12:34:56.000Z'));
  assert.equal(result, '2026-04-01T00:00:00.000Z');
});

test('isCooldownActive detects future timestamps', () => {
  assert.equal(isCooldownActive('2026-03-16T12:35:00.000Z', new Date('2026-03-16T12:34:56.000Z')), true);
  assert.equal(isCooldownActive('2026-03-16T12:34:00.000Z', new Date('2026-03-16T12:34:56.000Z')), false);
});