import { checkbox } from '@inquirer/prompts';
import { createDatabase } from '../../db/client.js';
import { loadConfig, resolveDatabasePath } from '../../config/store.js';
import { TOOLS } from '../wire/tools.js';

const VIRTUAL_KEY_PREFIX = 'mfk-';

export function registerWireCommand(program) {
  program
    .command('wire')
    .helpGroup('Common')
    .description('Point CLI tools (Claude Code, Codex, shell env, omp) at the mfk service via their own config')
    .option('--url <base>', 'Target mfk base URL (defaults to the local server from config)')
    .option('--key <alias|mfk-xxx>', 'Virtual key: an alias resolved locally, or a literal mfk- token. Required when wiring any tool on')
    .action(async (options) => {
      const configPath = program.opts().config;
      const { config, dir } = await loadConfig(configPath);
      const dbPath = resolveDatabasePath(dir, config.database.path);
      const db = createDatabase(dbPath);

      try {
        await runWire(configPath, config, db, options);
      } finally {
        db.close();
      }
    });
}

async function runWire(configPath, config, db, options) {
  const baseUrl = resolveBaseUrl(config, options.url);

  if (!process.stdin.isTTY) {
    throw new Error('mfk wire is interactive and requires a TTY.');
  }

  const state = TOOLS.map((tool) => ({ tool, wired: tool.detect(baseUrl) }));
  const selected = await checkbox({
    message: 'Toggle tools on/off for mfk (space to toggle):',
    choices: state.map(({ tool, wired }) => ({
      name: `${tool.label} — ${tool.description}`,
      value: tool.id,
      checked: wired,
    })),
    loop: false,
  });

  const selectedSet = new Set(selected);
  const changes = [];
  for (const { tool, wired } of state) {
    const desired = selectedSet.has(tool.id);
    if (desired && !wired) changes.push({ tool, action: 'wire' });
    else if (!desired && wired) changes.push({ tool, action: 'clear' });
  }

  if (changes.length === 0) {
    console.log('nothing changed');
    return;
  }

  const needsKey = changes.some((c) => c.action === 'wire');
  let virtualKey;
  if (needsKey) {
    if (!options.key) {
      throw new Error('--key is required to wire tools on (an alias or a literal mfk- token).');
    }
    virtualKey = resolveWireKey(db, options.key);
    console.log(`base_url: ${baseUrl}`);
    console.log(`virtual_key: ${virtualKey}`);
  }

  for (const { tool, action } of changes) {
    const summary = action === 'wire'
      ? await tool.wire({ baseUrl, virtualKey, configPath })
      : tool.clear();
    console.log(`${tool.label}: ${summary}`);
  }
}

function resolveBaseUrl(config, urlOption) {
  if (urlOption) {
    return urlOption.replace(/\/+$/, '');
  }
  const { host, port } = config.server;
  return `http://${host}:${port}`;
}

function resolveWireKey(db, keyArg) {
  const value = String(keyArg ?? '').trim();
  if (!value) {
    throw new Error('--key must not be empty');
  }
  if (value.startsWith(VIRTUAL_KEY_PREFIX)) {
    return value;
  }
  const record = db.findVirtualKeyByAlias(value);
  if (!record) {
    throw new Error(`Unknown virtual key alias: ${value}. Generate one with: mfk gen ${value}`);
  }
  return record.virtual_key;
}
