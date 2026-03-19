import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function createDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initialize(db);

  const statements = {
    getKeyState: db.prepare(`
      SELECT *
      FROM key_state
      WHERE provider_name = ? AND key_name = ?
    `),
    upsertKeyState: db.prepare(`
      INSERT INTO key_state (
        provider_name,
        key_name,
        disabled_until,
        failure_reason,
        last_error,
        last_error_at,
        last_success_at,
        consecutive_failures
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_name, key_name) DO UPDATE SET
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
        username,
        virtual_key,
        request_model,
        requested_provider,
        selected_provider,
        selected_key,
        status,
        error_type,
        error_message,
        latency_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    getKeyState(providerName, keyName) {
      return statements.getKeyState.get(providerName, keyName) ?? null;
    },
    markSuccess(providerName, keyName, timestamp = new Date().toISOString()) {
      const current = statements.getKeyState.get(providerName, keyName);
      statements.upsertKeyState.run(
        providerName,
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

      return statements.getKeyState.get(providerName, keyName) ?? null;
    },
    markFailure(providerName, keyName, failure) {
      const current = statements.getKeyState.get(providerName, keyName);
      const consecutiveFailures = (current?.consecutive_failures ?? 0) + 1;
      const timestamp = failure.timestamp ?? new Date().toISOString();

      statements.upsertKeyState.run(
        providerName,
        keyName,
        failure.disabledUntil ?? null,
        failure.reason ?? null,
        failure.message ?? null,
        timestamp,
        current?.last_success_at ?? null,
        consecutiveFailures,
      );

      return statements.getKeyState.get(providerName, keyName) ?? null;
    },
    logRequest(record) {
      statements.insertRequestLog.run(
        record.requestedAt ?? new Date().toISOString(),
        record.username,
        record.virtualKey,
        record.requestModel,
        record.requestedProvider ?? null,
        record.selectedProvider ?? null,
        record.selectedKey ?? null,
        record.status,
        record.errorType ?? null,
        record.errorMessage ?? null,
        record.latencyMs ?? null,
      );
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
      provider_name TEXT NOT NULL,
      key_name TEXT NOT NULL,
      disabled_until TEXT,
      failure_reason TEXT,
      last_error TEXT,
      last_error_at TEXT,
      last_success_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider_name, key_name)
    );

    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requested_at TEXT NOT NULL,
      username TEXT NOT NULL,
      virtual_key TEXT NOT NULL,
      request_model TEXT NOT NULL,
      requested_provider TEXT,
      selected_provider TEXT,
      selected_key TEXT,
      status TEXT NOT NULL,
      error_type TEXT,
      error_message TEXT,
      latency_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS virtual_keys (
      alias TEXT PRIMARY KEY,
      virtual_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
}