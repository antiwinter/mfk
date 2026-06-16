import { createDatabase } from '../../db/client.js';
import { findProvider, formatProviderKey, loadConfig, resolveDatabasePath } from '../../config/store.js';

export function registerRouteCommand(program) {
  program
    .command('route <alias> [rule]')
    .helpGroup('Virtual Keys')
    .description('Set or clear the routing rule for a virtual key')
    .addHelpText('after', `
Examples:
  mfk route mykey                    Clear route (auto)
  mfk route mykey gpt-4o             Fix model, any provider
  mfk route mykey ae29d/gpt-4o       Fix provider (short key) and model
  mfk route mykey 1/gpt-4o           Fix provider (index) and model`)
    .action(async (alias, rule) => {
      const trimmedAlias = String(alias ?? '').trim();
      if (!trimmedAlias) {
        throw new Error('Alias must not be empty');
      }

      const configPath = program.opts().config;
      const { config, dir } = await loadConfig(configPath);
      const dbPath = resolveDatabasePath(dir, config.database.path);
      const db = createDatabase(dbPath);

      try {
        const existing = db.findVirtualKeyByAlias(trimmedAlias);
        if (!existing) {
          throw new Error(`Virtual key not found: ${trimmedAlias}`);
        }

        const normalizedRule = normalizeRule(rule, config);
        const record = db.setVirtualKeyRoute(trimmedAlias, normalizedRule);

        console.log(`alias: ${record.alias}`);
        console.log(`route: ${record.route ?? 'auto'}`);
      } finally {
        db.close();
      }
    });
}

function normalizeRule(rule, config) {
  if (!rule) {
    return null;
  }

  const trimmed = String(rule).trim();
  if (!trimmed) {
    return null;
  }

  const slashIdx = trimmed.indexOf('/');
  if (slashIdx === -1) {
    // model-only rule
    return trimmed;
  }

  // provider/model rule — normalize provider to short key if resolvable
  const providerPart = trimmed.slice(0, slashIdx);
  const modelPart = trimmed.slice(slashIdx + 1);

  const provider = findProvider(config, providerPart);
  if (provider) {
    return `${formatProviderKey(provider.apiKey)}/${modelPart}`;
  }

  // provider not found — store as-is (user may have typed short key directly)
  return trimmed;
}
