import { createDatabase } from '../../db/client.js';
import { loadConfig, resolveDatabasePath } from '../../config/store.js';

export function registerRenameCommand(program) {
  program
    .command('rename <currentAlias> <nextAlias>')
    .helpGroup('Virtual Keys')
    .description('Rename a virtual key alias')
    .action(async (currentAlias, nextAlias) => {
      const fromAlias = String(currentAlias ?? '').trim();
      const toAlias = String(nextAlias ?? '').trim();

      if (!fromAlias || !toAlias) {
        throw new Error('Both current and next alias must be provided');
      }

      const configPath = program.opts().config;
      const { config, dir } = await loadConfig(configPath);
      const dbPath = resolveDatabasePath(dir, config.database.path);
      const db = createDatabase(dbPath);

      try {
        if (fromAlias !== toAlias && db.findVirtualKeyByAlias(toAlias)) {
          throw new Error(`Alias already exists: ${toAlias}`);
        }

        const record = db.renameVirtualKeyAlias(fromAlias, toAlias);
        if (!record) {
          throw new Error(`Virtual key not found: ${fromAlias}`);
        }

        console.log(`renamed_alias: ${fromAlias} -> ${record.alias}`);
        console.log(`virtual_key: ${record.virtual_key}`);
      } finally {
        db.close();
      }
    });
}