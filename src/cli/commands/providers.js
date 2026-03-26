import chalk from 'chalk';
import { millify } from 'millify';
import { createDatabase } from '../../db/client.js';
import { formatProviderKey, loadConfig, resolveDatabasePath } from '../../config/store.js';
import { isCooldownActive } from '../../lib/time.js';

export function registerProvidersCommand(program) {
  program
    .command('providers')
    .description('List providers and their current cooldown state')
    .action(async () => {
      const configPath = program.opts().config;
      const { config, dir } = await loadConfig(configPath);
      const dbPath = resolveDatabasePath(dir, config.database.path);
      const db = createDatabase(dbPath);

      try {
        if (config.providers.length === 0) {
          console.log('No providers found');
          return;
        }

        console.log('URL\tKEY\tSTATUS\tNOTE');

        for (const provider of config.providers) {
          console.log(formatProviderLine(provider, db.getKeyState(provider.key.name)));
        }
      } finally {
        db.close();
      }
    });
}

export function formatProviderLine(provider, state, now = new Date()) {
  const domain = getProviderDomain(provider.baseUrl);
  const key = formatProviderKey(provider.apiKey);
  const status = formatProviderStatus(state, now);
  const note = summarizeNote(state?.last_error);
  return `${key}\t${status}\t${domain}\t${note}`;
}

export function formatProviderStatus(state, now = new Date()) {
  if (!state || !isCooldownActive(state.disabled_until, now)) {
    return chalk.green('live');
  }

  const remainingHours = Math.max((new Date(state.disabled_until).getTime() - now.getTime()) / 3_600_000, 0);
  return chalk.red(`CD ${millify(remainingHours, { precision: 1 })}h`);
}

function getProviderDomain(baseUrl) {
  try {
    return new URL(baseUrl).hostname || baseUrl;
  } catch {
    return baseUrl;
  }
}

export function formatProviderUrl(baseUrl) {
  const domain = getProviderDomain(baseUrl);
  if (domain.length <= 16) {
    return domain;
  }

  return `${domain.slice(0, 13)}...`;
}

function summarizeNote(note) {
  const singleLine = String(note ?? '').replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return '-';
  }

  return singleLine.length > 160 ? `${singleLine.slice(0, 157)}...` : singleLine;
}