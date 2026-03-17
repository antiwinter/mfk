import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SERVER = {
  host: '127.0.0.1',
  port: 8787,
};

const DEFAULT_DATABASE = {
  path: './mfk.sqlite',
};

export function resolveConfigPath(configPath) {
  return path.resolve(process.cwd(), configPath ?? 'mfk.config.json');
}

export function normalizeConfig(rawConfig) {
  const config = rawConfig ?? {};
  const providers = Array.isArray(config.providers) ? config.providers.map(normalizeProvider) : [];

  return {
    server: {
      ...DEFAULT_SERVER,
      ...(config.server ?? {}),
    },
    database: {
      ...DEFAULT_DATABASE,
      ...(config.database ?? {}),
    },
    providers,
  };
}

function normalizeProvider(provider, providerIndex) {
  if (!provider?.name) {
    throw new Error(`Provider at index ${providerIndex} is missing a name`);
  }

  if (!provider?.type) {
    throw new Error(`Provider ${provider.name} is missing a type`);
  }

  if (!provider?.baseUrl) {
    throw new Error(`Provider ${provider.name} is missing a baseUrl`);
  }

  const keys = Array.isArray(provider.keys) ? provider.keys.map((keyConfig, keyIndex) => normalizeKey(provider, keyConfig, keyIndex)) : [];

  return {
    name: provider.name,
    type: provider.type,
    baseUrl: stripTrailingSlash(provider.baseUrl),
    priority: provider.priority ?? 100,
    quotaReset: provider.quotaReset ?? 'daily',
    failureReset: provider.failureReset ?? 'hourly',
    headers: provider.headers ?? {},
    models: Array.isArray(provider.models) ? provider.models : [],
    keys,
  };
}

function normalizeKey(provider, keyConfig, keyIndex) {
  if (!keyConfig?.name) {
    throw new Error(`Provider ${provider.name} key at index ${keyIndex} is missing a name`);
  }

  if (!keyConfig?.value) {
    throw new Error(`Provider ${provider.name} key ${keyConfig.name} is missing a value`);
  }

  return {
    name: keyConfig.name,
    value: keyConfig.value,
    priority: keyConfig.priority ?? 100,
  };
}

export async function loadConfig(configPath) {
  const resolvedPath = resolveConfigPath(configPath);
  const rawText = await fs.readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(rawText);
  const config = normalizeConfig(parsed);

  return {
    path: resolvedPath,
    dir: path.dirname(resolvedPath),
    config,
  };
}

export async function saveConfig(configPath, config) {
  const resolvedPath = resolveConfigPath(configPath);
  const normalized = normalizeConfig(config);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;

  await fs.writeFile(resolvedPath, serialized, 'utf8');
  return resolvedPath;
}

export function resolveDatabasePath(configDir, dbPath) {
  return path.resolve(configDir, dbPath ?? DEFAULT_DATABASE.path);
}

function stripTrailingSlash(value) {
  return value.replace(/\/$/, '');
}