import { createDatabase } from '../../db/client.js';
import { findProvider, formatProviderKey, loadConfig, resolveDatabasePath } from '../../config/store.js';

export function registerDisableCommand(program) {
  program
    .command('disable <key>')
    .helpGroup('Providers')
    .description('Manually disable a provider key')
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
        db.disableKey(provider.key.name);
        console.log(`provider: ${formatProviderKey(provider.apiKey)}`);
        console.log('status: disabled');
      } finally {
        db.close();
      }
    });
}
