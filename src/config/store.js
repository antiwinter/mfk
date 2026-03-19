import fs from 'node:fs/promises';
import path from 'node:path';
import { uniqueModels } from '../lib/http.js';

const DEFAULT_QUOTA_RESET = 'daily';
const DEFAULT_FAILURE_RESET = 'hourly';

const DEFAULT_SERVER = {
  host: '127.0.0.1',
  port: 8787,
};

const DEFAULT_DATABASE = {
  path: './mfk.sqlite',
};

const DEFAULT_MODEL_TIER = [];

export function resolveConfigPath(configPath) {
  return path.resolve(process.cwd(), configPath ?? 'mfk.config.json');
}

export function normalizeConfig(rawConfig) {
  const config = rawConfig ?? {};
  const providers = normalizeProviders(config.providers);

  return {
    server: {
      ...DEFAULT_SERVER,
      ...(config.server ?? {}),
    },
    database: {
      ...DEFAULT_DATABASE,
      ...(config.database ?? {}),
    },
    modelTier: normalizeModelTier(config.modelTier),
    providers,
  };
}

function normalizeModelTier(rawModelTier) {
  if (!Array.isArray(rawModelTier)) {
    return [...DEFAULT_MODEL_TIER];
  }

  return rawModelTier
    .map((group) => uniqueModels(Array.isArray(group) ? group.filter(Boolean) : []))
    .filter((group) => group.length > 0);
}

function normalizeProviders(rawProviders) {
  if (Array.isArray(rawProviders)) {
    return rawProviders.flatMap((provider, providerIndex) => normalizeLegacyProvider(provider, providerIndex));
  }

  if (!rawProviders || typeof rawProviders !== 'object') {
    return [];
  }

  return Object.entries(rawProviders).map(([apiKey, provider], providerIndex) =>
    normalizeProviderEntry(apiKey, provider, providerIndex),
  );
}

function normalizeLegacyProvider(provider, providerIndex) {
  if (!provider?.type) {
    throw new Error(`Provider at index ${providerIndex} is missing a type`);
  }

  const baseUrl = stripTrailingSlash(provider.url ?? provider.baseUrl ?? '');
  if (!baseUrl) {
    throw new Error(`Provider at index ${providerIndex} is missing a url`);
  }

  const keys = Array.isArray(provider.keys) ? provider.keys : [];
  return keys.map((keyConfig, keyIndex) => {
    if (!keyConfig?.value) {
      throw new Error(`Provider at index ${providerIndex} key at index ${keyIndex} is missing a value`);
    }

    return buildRuntimeProvider({
      apiKey: keyConfig.value,
      baseUrl,
      type: provider.type,
      quotaReset: provider.quotaReset,
      failureReset: provider.failureReset,
      models: provider.models,
      order: providerIndex + keyIndex,
    });
  });
}

function normalizeProviderEntry(apiKey, provider, providerIndex) {
  if (!apiKey) {
    throw new Error(`Provider at index ${providerIndex} is missing an api key`);
  }

  if (!provider?.type) {
    throw new Error(`Provider ${maskApiKey(apiKey)} is missing a type`);
  }

  const baseUrl = stripTrailingSlash(provider.url ?? provider.baseUrl ?? '');
  if (!baseUrl) {
    throw new Error(`Provider ${maskApiKey(apiKey)} is missing a url`);
  }

  return buildRuntimeProvider({
    apiKey,
    baseUrl,
    type: normalizeProviderType(provider.type),
    quotaReset: provider.quotaReset,
    failureReset: provider.failureReset,
    models: provider.models,
    order: providerIndex,
  });
}

export function buildRuntimeProvider({ apiKey, baseUrl, type, quotaReset, failureReset, models, order }) {
  const providerId = createProviderId(baseUrl, apiKey);

  return {
    id: providerId,
    apiKey,
    type: normalizeProviderType(type),
    baseUrl,
    order,
    priority: order,
    quotaReset: quotaReset ?? DEFAULT_QUOTA_RESET,
    failureReset: failureReset ?? DEFAULT_FAILURE_RESET,
    headers: {},
    models: Array.isArray(models) ? uniqueModels(models).sort(compareText) : [],
    key: {
      name: providerId,
      value: apiKey,
      priority: order,
    },
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
  const preservedModelTier = await loadPersistedModelTier(resolvedPath);
  const serializedConfig = serializeConfig(normalized, preservedModelTier);
  const serialized = `${JSON.stringify(serializedConfig, null, 2)}\n`;

  await fs.writeFile(resolvedPath, serialized, 'utf8');
  return resolvedPath;
}

export function resolveDatabasePath(configDir, dbPath) {
  return path.resolve(configDir, dbPath ?? DEFAULT_DATABASE.path);
}

export function findProvider(config, selector) {
  const value = String(selector ?? '').trim();
  if (!value) {
    return null;
  }

  return config.providers.find((provider, index) => (
    value === String(index + 1)
    || value === provider.apiKey
    || value === provider.baseUrl
    || value === provider.id
  )) ?? null;
}

export function formatProviderRef(provider) {
  return `${provider.order + 1}`;
}

function serializeConfig(config, preservedModelTier) {
  const serialized = {
    server: {
      ...config.server,
    },
    database: {
      ...config.database,
    },
    providers: Object.fromEntries(config.providers.map((provider) => [
      provider.apiKey,
      serializeProvider(provider),
    ])),
  };

  if (Array.isArray(preservedModelTier) && preservedModelTier.length > 0) {
    serialized.modelTier = preservedModelTier;
  }

  return serialized;
}

async function loadPersistedModelTier(configPath) {
  try {
    const rawText = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed?.modelTier) ? parsed.modelTier : null;
  } catch {
    return null;
  }
}

function serializeProvider(provider) {
  const serialized = {
    url: provider.baseUrl,
    type: normalizeProviderType(provider.type),
    models: uniqueModels(provider.models).sort(compareText),
  };

  if (provider.quotaReset !== DEFAULT_QUOTA_RESET) {
    serialized.quotaReset = provider.quotaReset;
  }

  if (provider.failureReset !== DEFAULT_FAILURE_RESET) {
    serialized.failureReset = provider.failureReset;
  }

  return serialized;
}

function stripTrailingSlash(value) {
  return value.replace(/\/$/, '');
}

function compareText(left, right) {
  return left.localeCompare(right);
}

function createProviderId(baseUrl, apiKey) {
  const host = new URL(baseUrl).host.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = apiKey.slice(-4).toLowerCase();
  return `${host || 'provider'}-${suffix}`;
}

function maskApiKey(apiKey) {
  if (!apiKey || apiKey.length <= 8) {
    return apiKey;
  }

  return `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`;
}

function normalizeProviderType(type) {
  return type === 'openai-compatible' ? 'openai' : type;
}