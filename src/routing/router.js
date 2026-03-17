import { getProviderAdapter } from '../providers/index.js';
import { isCooldownActive, computeNextBoundary } from '../lib/time.js';

export async function routeRequest({ config, db, request, username, virtualKey }) {
  const candidates = selectCandidates(config, db, request);
  const requestedAt = new Date().toISOString();

  if (candidates.length === 0) {
    db.logRequest({
      requestedAt,
      username,
      virtualKey,
      requestModel: request.model,
      requestedProvider: request.provider,
      status: 'no_candidate',
      errorType: 'routing',
      errorMessage: `No provider is configured for model ${request.model}`,
    });

    const error = new Error(`No provider is configured for model ${request.model}`);
    error.statusCode = 404;
    throw error;
  }

  let lastError = null;

  for (const candidate of candidates) {
    const startedAt = Date.now();
    try {
      const adapter = getProviderAdapter(candidate.provider.type);
      const response = await adapter.invoke(candidate.provider, candidate.key, request);
      db.markSuccess(candidate.provider.name, candidate.key.name);
      db.logRequest({
        requestedAt,
        username,
        virtualKey,
        requestModel: request.model,
        requestedProvider: request.provider,
        selectedProvider: candidate.provider.name,
        selectedKey: candidate.key.name,
        status: 'success',
        latencyMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      lastError = error;
      const errorType = error.errorType ?? 'fatal';
      const disabledUntil = shouldDisable(errorType)
        ? computeNextBoundary(errorType === 'quota' ? candidate.provider.quotaReset : candidate.provider.failureReset)
        : null;

      db.markFailure(candidate.provider.name, candidate.key.name, {
        disabledUntil,
        reason: errorType,
        message: error.message,
      });
      db.logRequest({
        requestedAt,
        username,
        virtualKey,
        requestModel: request.model,
        requestedProvider: request.provider,
        selectedProvider: candidate.provider.name,
        selectedKey: candidate.key.name,
        status: 'failed',
        errorType,
        errorMessage: error.message,
        latencyMs: Date.now() - startedAt,
      });

      if (!error.retryable) {
        continue;
      }
    }
  }

  const error = new Error(lastError?.message ?? 'All candidate providers failed');
  error.statusCode = lastError?.statusCode ?? 503;
  throw error;
}

function selectCandidates(config, db, request) {
  const now = new Date();
  const requestedProvider = request.provider?.trim();
  const candidates = [];

  for (const provider of config.providers) {
    if (requestedProvider && provider.name !== requestedProvider && provider.type !== requestedProvider) {
      continue;
    }

    const supportsModel = provider.models.length === 0 || provider.models.includes(request.model);
    if (!supportsModel) {
      continue;
    }

    for (const key of provider.keys) {
      const state = db.getKeyState(provider.name, key.name);
      if (isCooldownActive(state?.disabled_until, now)) {
        continue;
      }

      candidates.push({
        provider,
        key,
        keyState: state,
      });
    }
  }

  return candidates.sort((left, right) => {
    if (left.provider.priority !== right.provider.priority) {
      return left.provider.priority - right.provider.priority;
    }

    return left.key.priority - right.key.priority;
  });
}

function shouldDisable(errorType) {
  return errorType === 'quota' || errorType === 'retryable' || errorType === 'auth';
}