import { createDatabase } from '../../db/client.js';
import { loadConfig, resolveDatabasePath } from '../../config/store.js';
import { normalizeModelId } from '../../lib/models.js';
import { formatProviderLine } from './providers.js';

function trimModelDisplay(model) {
  return normalizeModelId(model).replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

export function registerListCommand(program) {
  program
    .command('ls')
    .alias('list')
    .helpGroup('Common')
    .description('List providers, models, and virtual keys')
    .option('-l, --long', 'Show models for each provider')
    .option('-k, --keys', 'Show virtual keys')
    .action(async (options) => {
      const configPath = program.opts().config;
      const { config, dir } = await loadConfig(configPath);
      const dbPath = resolveDatabasePath(dir, config.database.path);
      const db = createDatabase(dbPath);

      try {
        if (config.providers.length === 0) {
          console.log('No providers found');
        } else {
          console.log('KEY\tSTATUS\tURL\tNOTE');
          for (const provider of config.providers) {
            console.log(formatProviderLine(provider, db.getKeyState(provider.key.name)));
            if (options.long && provider.models?.length > 0) {
              for (const model of provider.models) {
                if (model === '*' || String(model).endsWith('/*')) continue;
                console.log(`  ${trimModelDisplay(model)}`);
              }
            }
          }
        }

        if (options.keys) {
          const records = db.listVirtualKeys();
          console.log('');
          if (records.length === 0) {
            console.log('No virtual keys found');
          } else {
            console.log('ALIAS\tVIRTUAL KEY');
            for (const record of records) {
              console.log(`${record.alias}\t${record.virtual_key}`);
            }
          }
        }
      } finally {
        db.close();
      }
    });
}