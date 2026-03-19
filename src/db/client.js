import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function normalizeRequestLogRecord(record) {
  return {
    requested_at: record.requestedAt ?? new Date().toISOString(),
    alias: record.alias,
    request_model: record.requestModel,
    selected_key: record.selectedKey ?? null,
    status: record.status,
    error_type: record.errorType ?? null,
    error_message: record.errorMessage ?? null,
    latency_ms: record.latencyMs ?? null,
    input_tokens: record.inputTokens ?? null,
    output_tokens: record.outputTokens ?? null,
  };
}

export function createDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initialize(db);

  const statements = {
    getKeyState: db.prepare(`
      SELECT *
      FROM key_state
      WHERE key_name = ?
    `),
    upsertKeyState: db.prepare(`
      INSERT INTO key_state (
        key_name,
        disabled_until,
        failure_reason,
        last_error,
        last_error_at,
        last_success_at,
        consecutive_failures
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key_name) DO UPDATE SET
        disabled_until = excluded.disabled_until,
        failure_reason = excluded.failure_reason,
        last_error = excluded.last_error,
        last_error_at = excluded.last_error_at,
        last_success_at = excluded.last_success_at,
        consecutive_failures = excluded.consecutive_failures
    `),
    insertRequestLog: db.prepare(`
      INSERT INTO request_log (
        requested_at,
        alias,
        request_model,
        selected_key,
        status,
        error_type,
        error_message,
        latency_ms,
        input_tokens,
        output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listRequestLogs: db.prepare(`
      SELECT *
      FROM request_log
      ORDER BY id ASC
    `),
    insertVirtualKey: db.prepare(`
      INSERT INTO virtual_keys (
        alias,
        virtual_key,
        created_at
      ) VALUES (?, ?, ?)
    `),
    getVirtualKeyByAlias: db.prepare(`
      SELECT *
      FROM virtual_keys
      WHERE alias = ?
    `),
    getVirtualKeyByToken: db.prepare(`
      SELECT *
      FROM virtual_keys
      WHERE virtual_key = ?
    `),
    listVirtualKeys: db.prepare(`
      SELECT *
      FROM virtual_keys
      ORDER BY alias ASC
    `),
    deleteVirtualKeyByAlias: db.prepare(`
      DELETE FROM virtual_keys
      WHERE alias = ?
    `),
    deleteVirtualKeyByToken: db.prepare(`
      DELETE FROM virtual_keys
      WHERE virtual_key = ?
    `),
  };

  return {
    getKeyState(keyName) {
      return statements.getKeyState.get(keyName) ?? null;
    },
    markSuccess(keyName, timestamp = new Date().toISOString()) {
      const current = statements.getKeyState.get(keyName);
      statements.upsertKeyState.run(
        keyName,
        null,
        null,
        null,
        null,
        timestamp,
        0,
      );

      if (current && current.last_success_at === timestamp) {
        return current;
      }

      return statements.getKeyState.get(keyName) ?? null;
    },
    markFailure(keyName, failure) {
      const current = statements.getKeyState.get(keyName);
      const consecutiveFailures = (current?.consecutive_failures ?? 0) + 1;
      const timestamp = failure.timestamp ?? new Date().toISOString();

      statements.upsertKeyState.run(
        keyName,
        failure.disabledUntil ?? null,
        failure.reason ?? null,
        failure.message ?? null,
        timestamp,
        current?.last_success_at ?? null,
        consecutiveFailures,
      );

      return statements.getKeyState.get(keyName) ?? null;
    },
    logRequest(record) {
      const row = normalizeRequestLogRecord(record);
      statements.insertRequestLog.run(
        row.requested_at,
        row.alias,
        row.request_model,
        row.selected_key,
        row.status,
        row.error_type,
        row.error_message,
        row.latency_ms,
        row.input_tokens,
        row.output_tokens,
      );

      return row;
    },
    listRequestLogs() {
      return statements.listRequestLogs.all();
    },
    createVirtualKey(alias, virtualKey, createdAt = new Date().toISOString()) {
      statements.insertVirtualKey.run(alias, virtualKey, createdAt);
      return statements.getVirtualKeyByAlias.get(alias) ?? null;
    },
    findVirtualKeyByAlias(alias) {
      return statements.getVirtualKeyByAlias.get(alias) ?? null;
    },
    findVirtualKeyByToken(virtualKey) {
      return statements.getVirtualKeyByToken.get(virtualKey) ?? null;
    },
    listVirtualKeys() {
      return statements.listVirtualKeys.all();
    },
    deleteVirtualKeyByAlias(alias) {
      const existing = statements.getVirtualKeyByAlias.get(alias) ?? null;
      if (!existing) {
        return null;
      }

      statements.deleteVirtualKeyByAlias.run(alias);
      return existing;
    },
    deleteVirtualKeyByToken(virtualKey) {
      const existing = statements.getVirtualKeyByToken.get(virtualKey) ?? null;
      if (!existing) {
        return null;
      }

      statements.deleteVirtualKeyByToken.run(virtualKey);
      return existing;
    },
    close() {
      db.close();
    },
  };
}

function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS key_state (
      key_name TEXT NOT NULL,
      disabled_until TEXT,
      failure_reason TEXT,
      last_error TEXT,
      last_error_at TEXT,
      last_success_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_name)
    );

    CREATE TABLE IF NOT EXISTS virtual_keys (
      alias TEXT PRIMARY KEY,
      virtual_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requested_at TEXT NOT NULL,
      alias TEXT NOT NULL,
      request_model TEXT NOT NULL,
      selected_key TEXT,
      status TEXT NOT NULL,
      error_type TEXT,
      error_message TEXT,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER
    );
  `);
}