import { createDatabase } from '../../db/client.js';
import { loadConfig, resolveDatabasePath } from '../../config/store.js';
import { formatProviderKey } from './providers.js';

export function registerResetCommand(program) {
  program
    .command('reset <key>')
    .description('Reset provider cooldown state by provider key from mfk providers')
    .action(async (key) => {
      const selector = String(key ?? '').trim();
      if (!selector) {
        throw new Error('Provider key must not be empty');
      }

      const configPath = program.opts().config;
      const { config, dir } = await loadConfig(configPath);
      const provider = resolveProviderForReset(config.providers, selector);
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

export function resolveProviderForReset(providers, selector) {
  const value = String(selector ?? '').trim();
  if (!value) {
    return null;
  }

  const lowered = value.toLowerCase();
  const exactMatch = providers.find((provider, index) => (
    value === String(index + 1)
    || value === provider.apiKey
    || value === provider.baseUrl
    || value === provider.id
    || value === formatProviderKey(provider.apiKey)
  ));

  if (exactMatch) {
    return exactMatch;
  }

  const partialMatches = providers.filter((provider) => {
    const haystacks = [
      provider.apiKey,
      provider.baseUrl,
      provider.id,
      formatProviderKey(provider.apiKey),
    ].map((entry) => String(entry ?? '').toLowerCase());

    return haystacks.some((entry) => entry.includes(lowered));
  });

  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  if (partialMatches.length > 1) {
    const rendered = partialMatches.map((provider) => formatProviderKey(provider.apiKey)).join(', ');
    throw new Error(`Ambiguous provider selector: ${selector} (${rendered})`);
  }

  return null;
}