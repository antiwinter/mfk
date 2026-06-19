import { uniqueModels } from './http.js';

const MODEL_NAMESPACE_PREFIX = /^(anthropic|openai|google|models)\//;

export function normalizeModelId(model) {
  return String(model ?? '').replace(MODEL_NAMESPACE_PREFIX, '');
}

function extractModelName(model) {
  const normalized = normalizeModelId(model).replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    return '';
  }

  const segments = normalized.split('/').filter(Boolean);
  return segments.at(-1) ?? '';
}

export function isConcreteModel(model) {
  return Boolean(model) && model !== '*' && !String(model).endsWith('/*');
}

export function getCapabilityModels(config) {
  const providerModels = (config?.providers ?? []).flatMap((provider) => provider.models ?? []);

  return uniqueModels(providerModels.filter(isConcreteModel)).sort(compareText);
}

export function getCapabilityModelInfos(config) {
  const providers = config?.providers ?? [];
  return getCapabilityModels(config).map((id) => ({
    id,
    apiType: resolveApiTypeForModel(providers, id),
  }));
}

function resolveApiTypeForModel(providers, modelId) {
  for (const provider of providers) {
    if (resolveProviderModel(provider, modelId)) {
      return providerTypeToApiType(provider.type);
    }
  }
  return 'openai-completions';
}

function providerTypeToApiType(type) {
  if (type === 'anthropic') return 'anthropic-messages';
  if (type === 'google') return 'google-genai';
  return 'openai-completions';
}

export function resolveProviderModel(provider, requestedModel) {
  const normalizedRequested = normalizeModelId(requestedModel);
  const requestedName = extractModelName(requestedModel);

  for (const model of provider.models ?? []) {
    if (model === '*') {
      return requestedModel;
    }

    if (model.endsWith('/*')) {
      const prefix = model.slice(0, -1);
      if (requestedModel.startsWith(prefix) || normalizedRequested.startsWith(prefix)) {
        return requestedModel;
      }
      continue;
    }

    if (
      model === requestedModel
      || normalizeModelId(model) === normalizedRequested
      || extractModelName(model) === requestedName
    ) {
      return model;
    }
  }

  // Substring fallback: find a model whose name contains the requested string
  if (requestedName) {
    const substringMatch = (provider.models ?? []).find((model) => {
      if (model === '*' || model.endsWith('/*')) return false;
      return normalizeModelId(model).includes(requestedName);
    });
    if (substringMatch) return substringMatch;
  }

  return null;
}

function compareText(left, right) {
  return String(left).localeCompare(String(right));
}