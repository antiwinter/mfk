import { createDatabase } from '../../db/client.js';
import { formatProviderKey, loadConfig, resolveDatabasePath, saveConfig } from '../../config/store.js';

const VIRTUAL_KEY_PREFIX = 'mfk-';

export function registerRmCommand(program) {
  program
    .command('rm <selector>')
    .helpGroup('Common')
    .description('Remove a virtual key, alias, or provider key')
    .action(async (selectorArg) => {
      const selector = String(selectorArg ?? '').trim();
      if (!selector) {
        throw new Error('Selector must not be empty');
      }

      const configPath = program.opts().config;
      const { config, dir } = await loadConfig(configPath);
      const dbPath = resolveDatabasePath(dir, config.database.path);
      const db = createDatabase(dbPath);

      try {
        // Try virtual key removal first
        const record = selector.startsWith(VIRTUAL_KEY_PREFIX)
          ? db.deleteVirtualKeyByToken(selector) ?? db.deleteVirtualKeyByAlias(selector)
          : db.deleteVirtualKeyByAlias(selector);

        if (record) {
          console.log(`removed_alias: ${record.alias}`);
          console.log(`removed_virtual_key: ${record.virtual_key}`);
          return;
        }

        // Try provider removal by full key or short key
        const provider = config.providers.find((p) =>
          selector === p.apiKey || selector === formatProviderKey(p.apiKey),
        );
        if (provider) {
          config.providers = config.providers.filter((p) => p.id !== provider.id);
          await saveConfig(configPath, config);
          console.log(`removed_provider_key: ${formatProviderKey(provider.apiKey)}`);
          console.log(`removed_provider_url: ${provider.baseUrl}`);
          return;
        }

        throw new Error(`No virtual key or provider found: ${selector}`);
      } finally {
        db.close();
      }
    });
}