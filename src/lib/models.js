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

  return null;
}

export function resolveNearestProviderModel(modelTier, provider, requestedModel) {
  const requestedTierIndex = getModelTierIndex(modelTier, requestedModel);
  if (requestedTierIndex === null) {
    return null;
  }

  let bestMatch = null;

  for (const model of provider.models ?? []) {
    if (!isConcreteModel(model)) {
      continue;
    }

    const tierIndex = getModelTierIndex(modelTier, model);
    if (tierIndex === null) {
      continue;
    }

    const distance = Math.abs(tierIndex - requestedTierIndex);
    if (!bestMatch || compareTierMatch({ model, tierIndex, distance }, bestMatch) < 0) {
      bestMatch = { model, tierIndex, distance };
    }
  }

  return bestMatch;
}

export function getModelTierIndex(modelTier, model) {
  const groups = Array.isArray(modelTier) ? modelTier : [];

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index] ?? [];
    if (group.some((alias) => modelsMatch(model, alias))) {
      return index;
    }
  }

  return null;
}

export function modelsMatch(left, right) {
  const normalizedLeft = extractModelName(left).toLowerCase();
  const normalizedRight = extractModelName(right).toLowerCase();

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return normalizedLeft === normalizedRight
    || normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft);
}

function compareTierMatch(left, right) {
  if (left.distance !== right.distance) {
    return left.distance - right.distance;
  }

  if (left.tierIndex !== right.tierIndex) {
    return left.tierIndex - right.tierIndex;
  }

  return compareText(left.model, right.model);
}

function compareText(left, right) {
  return String(left).localeCompare(String(right));
}