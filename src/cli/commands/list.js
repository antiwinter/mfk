import { createDatabase } from '../../db/client.js';
import { loadConfig, resolveDatabasePath } from '../../config/store.js';

export function registerListCommand(program) {
  program
    .command('list')
    .description('List all virtual key alias mappings')
    .action(async (command) => {
      const configPath = program.opts().config;
      const { config, dir } = await loadConfig(configPath);
      const dbPath = resolveDatabasePath(dir, config.database.path);
      const db = createDatabase(dbPath);

      try {
        const records = db.listVirtualKeys();
        if (records.length === 0) {
          console.log('No virtual keys found');
          return;
        }

        for (const record of records) {
          console.log(`${record.alias}\t${record.virtual_key}`);
        }
      } finally {
        db.close();
      }
    });
}