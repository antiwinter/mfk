import { createDatabase } from '../../db/client.js';
import { loadConfig, resolveDatabasePath } from '../../config/store.js';

const VIRTUAL_KEY_PREFIX = 'mfk-';

export function registerRmCommand(program) {
  program
    .command('rm <aliasOrKey>')
    .description('Remove a virtual key by alias or virtual key')
    .action(async (aliasOrKey, command) => {
      const selector = String(aliasOrKey ?? '').trim();
      if (!selector) {
        throw new Error('Alias or virtual key must not be empty');
      }

      const configPath = command.optsWithGlobals().config;
      const { config, dir } = await loadConfig(configPath);
      const dbPath = resolveDatabasePath(dir, config.database.path);
      const db = createDatabase(dbPath);

      try {
        const record = selector.startsWith(VIRTUAL_KEY_PREFIX)
          ? db.deleteVirtualKeyByToken(selector) ?? db.deleteVirtualKeyByAlias(selector)
          : db.deleteVirtualKeyByAlias(selector);

        if (!record) {
          throw new Error(`Virtual key not found: ${selector}`);
        }

        console.log(`removed_alias: ${record.alias}`);
        console.log(`removed_virtual_key: ${record.virtual_key}`);
      } finally {
        db.close();
      }
    });
}