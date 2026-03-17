import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
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
  `);
}