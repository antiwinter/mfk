import { createDatabase } from '../../db/client.js';
import { findProvider, formatProviderKey, loadConfig, resolveDatabasePath } from '../../config/store.js';

export function registerResetCommand(program) {
  program
    .command('reset <key>')
    .helpGroup('Providers')
    .description('Reset provider cooldown state by provider key from mfk providers')
    .action(async (key) => {
      const selector = String(key ?? '').trim();
      if (!selector) {
        throw new Error('Provider key must not be empty');
      }

      const configPath = program.opts().config;
      const { config, dir } = await loadConfig(configPath);
      const provider = findProvider(config, selector);
      if (!provider) {
        throw new Error(`Unknown provider: ${selector}`);
      }

      const dbPath = resolveDatabasePath(dir, config.database.path);
      const db = createDatabase(dbPath);

      try {
        const previous = db.resetKeyState(provider.key.name);
        console.log(`provider: ${formatProviderKey(provider.apiKey)}`);
        console.log('status: live');
        console.log(`reset: ${previous ? 'ok' : 'noop'}`);
      } finally {
        db.close();
      }
    });
}