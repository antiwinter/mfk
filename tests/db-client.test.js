import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../src/db/client.js';

function createTempDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfk-db-'));
  return createDatabase(path.join(tempDir, 'test.sqlite'));
}

test('virtual key records can be created and looked up', () => {
  const db = createTempDb();

  try {
    const record = db.createVirtualKey('alice', 'mfk-0123456789abcdef01234567', '2026-03-19T00:00:00.000Z');

    assert.equal(record.alias, 'alice');
    assert.equal(record.virtual_key, 'mfk-0123456789abcdef01234567');
    assert.equal(db.findVirtualKeyByAlias('alice')?.virtual_key, 'mfk-0123456789abcdef01234567');
    assert.equal(db.findVirtualKeyByToken('mfk-0123456789abcdef01234567')?.alias, 'alice');
  } finally {
    db.close();
  }
});

test('virtual key aliases must be unique', () => {
  const db = createTempDb();

  try {
    db.createVirtualKey('alice', 'mfk-0123456789abcdef01234567');

    assert.throws(
      () => db.createVirtualKey('alice', 'mfk-fedcba9876543210fedcba98'),
      /UNIQUE constraint failed: virtual_keys.alias/,
    );
  } finally {
    db.close();
  }
});

test('virtual keys must be unique', () => {
  const db = createTempDb();

  try {
    db.createVirtualKey('alice', 'mfk-0123456789abcdef01234567');

    assert.throws(
      () => db.createVirtualKey('bob', 'mfk-0123456789abcdef01234567'),
      /UNIQUE constraint failed: virtual_keys.virtual_key/,
    );
  } finally {
    db.close();
  }
});

test('virtual keys are listed in alias order', () => {
  const db = createTempDb();

  try {
    db.createVirtualKey('bravo', 'mfk-111111111111111111111111');
    db.createVirtualKey('alpha', 'mfk-222222222222222222222222');

    assert.deepEqual(db.listVirtualKeys().map((entry) => entry.alias), ['alpha', 'bravo']);
  } finally {
    db.close();
  }
});

test('virtual keys can be deleted by alias or token', () => {
  const db = createTempDb();

  try {
    db.createVirtualKey('alpha', 'mfk-111111111111111111111111');
    db.createVirtualKey('bravo', 'mfk-222222222222222222222222');

    const removedByAlias = db.deleteVirtualKeyByAlias('alpha');
    const removedByToken = db.deleteVirtualKeyByToken('mfk-222222222222222222222222');

    assert.equal(removedByAlias?.virtual_key, 'mfk-111111111111111111111111');
    assert.equal(removedByToken?.alias, 'bravo');
    assert.equal(db.listVirtualKeys().length, 0);
  } finally {
    db.close();
  }
});

test('request logs store alias, selected key, and token counts', () => {
  const db = createTempDb();

  try {
    db.logRequest({
      requestedAt: '2026-03-19T00:00:00.000Z',
      alias: 'alice',
      requestModel: 'anthropic/claude-sonnet-4-6',
      selectedKey: 'anthropic-key',
      status: 'success',
      latencyMs: 321,
      inputTokens: 123,
      outputTokens: 45,
    });

    const [record] = db.listRequestLogs();
    assert.equal(record.alias, 'alice');
    assert.equal(record.request_model, 'anthropic/claude-sonnet-4-6');
    assert.equal(record.selected_key, 'anthropic-key');
    assert.equal(record.status, 'success');
    assert.equal(record.latency_ms, 321);
    assert.equal(record.input_tokens, 123);
    assert.equal(record.output_tokens, 45);
  } finally {
    db.close();
  }
});