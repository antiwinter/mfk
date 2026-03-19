import crypto from 'node:crypto';
import { createDatabase } from '../../db/client.js';
import { loadConfig, resolveDatabasePath } from '../../config/store.js';

const KEY_BYTES = 12;
const MAX_GENERATION_ATTEMPTS = 5;

export function registerGenCommand(program) {
  program
    .command('gen <alias>')
    .description('Generate a virtual key for an alias')
    .action(async (alias, command) => {
      const trimmedAlias = String(alias ?? '').trim();
      if (!trimmedAlias) {
        throw new Error('Alias must not be empty');
      }

      const configPath = command.optsWithGlobals().config;
      const { config, dir } = await loadConfig(configPath);
      const dbPath = resolveDatabasePath(dir, config.database.path);
      const db = createDatabase(dbPath);

      try {
        if (db.findVirtualKeyByAlias(trimmedAlias)) {
          throw new Error(`Alias already exists: ${trimmedAlias}`);
        }

        const record = createUniqueVirtualKey(db, trimmedAlias);
        console.log(`alias: ${record.alias}`);
        console.log(`virtual_key: ${record.virtual_key}`);
      } finally {
        db.close();
      }
    });
}

function createUniqueVirtualKey(db, alias) {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const virtualKey = `mfk-${crypto.randomBytes(KEY_BYTES).toString('hex')}`;
    if (db.findVirtualKeyByToken(virtualKey)) {
      continue;
    }

    return db.createVirtualKey(alias, virtualKey);
  }

  throw new Error('Unable to generate a unique virtual key');
}