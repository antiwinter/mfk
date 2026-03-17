import { getProviderAdapter } from '../providers/index.js';
import { isCooldownActive, computeNextBoundary } from '../lib/time.js';

export async function routeRequest({ config, db, request, username, virtualKey }) {
  const candidates = selectCandidates(config, db, request);
  const requestedAt = new Date().toISOString();
  debugLog('route_request', {
    model: request.model,
    normalizedModel: normalizeModelId(request.model),
    provider: request.provider ?? null,
    username,
    candidateCount: candidates.length,
    candidates: candidates.map((candidate) => ({
      providerId: candidate.provider.id,
      type: candidate.provider.type,
      url: candidate.provider.baseUrl,
      sampleModels: candidate.provider.models.slice(0, 5),
    })),
  });

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
      db.markSuccess(candidate.provider.id, candidate.key.name);
      db.logRequest({
        requestedAt,
        username,
        virtualKey,
        requestModel: request.model,
        requestedProvider: request.provider,
        selectedProvider: candidate.provider.id,
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

      db.markFailure(candidate.provider.id, candidate.key.name, {
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
        selectedProvider: candidate.provider.id,
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

export async function routeRequestStream({ config, db, request, username, virtualKey, onText }) {
  const candidates = selectCandidates(config, db, request);
  const requestedAt = new Date().toISOString();
  debugLog('route_request_stream', {
    model: request.model,
    normalizedModel: normalizeModelId(request.model),
    provider: request.provider ?? null,
    username,
    candidateCount: candidates.length,
    candidates: candidates.map((candidate) => ({
      providerId: candidate.provider.id,
      type: candidate.provider.type,
      url: candidate.provider.baseUrl,
      sampleModels: candidate.provider.models.slice(0, 5),
    })),
  });

  if (candidates.length === 0) {
    const error = new Error(`No provider is configured for model ${request.model}`);
    error.statusCode = 404;
    throw error;
  }

  let lastError = null;

  for (const candidate of candidates) {
    const startedAt = Date.now();
    let emittedText = false;

    try {
      const adapter = getProviderAdapter(candidate.provider.type);
      const response = adapter.invokeStream
        ? await adapter.invokeStream(candidate.provider, candidate.key, request, {
            onText: (chunk) => {
              emittedText = true;
              onText?.(chunk);
            },
          })
        : await adapter.invoke(candidate.provider, candidate.key, request);

      db.markSuccess(candidate.provider.id, candidate.key.name);
      db.logRequest({
        requestedAt,
        username,
        virtualKey,
        requestModel: request.model,
        requestedProvider: request.provider,
        selectedProvider: candidate.provider.id,
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

      db.markFailure(candidate.provider.id, candidate.key.name, {
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
        selectedProvider: candidate.provider.id,
        selectedKey: candidate.key.name,
        status: 'failed',
        errorType,
        errorMessage: error.message,
        latencyMs: Date.now() - startedAt,
      });

      if (emittedText || !error.retryable) {
        break;
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
    if (requestedProvider && !matchesProviderSelector(provider, requestedProvider)) {
      continue;
    }

    const supportsModel = provider.models.length === 0 || providerSupportsModel(provider, request.model);
    if (!supportsModel) {
      continue;
    }

    for (const key of provider.keys) {
      const state = db.getKeyState(provider.id, key.name);
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

function providerSupportsModel(provider, requestedModel) {
  const normalizedRequested = normalizeModelId(requestedModel);
  return provider.models.some((model) => {
    if (model === '*' || model.endsWith('/*')) {
      return true;
    }

    return model === requestedModel || normalizeModelId(model) === normalizedRequested;
  });
}

function matchesProviderSelector(provider, selector) {
  return selector === provider.type
    || selector === provider.baseUrl
    || selector === provider.apiKey
    || selector === provider.id
    || selector === String(provider.order + 1);
}

function normalizeModelId(model) {
  return String(model ?? '').replace(/^(anthropic|openai|google|models)\//, '');
}

function debugLog(event, payload) {
  if (process.env.MFK_DEBUG !== '1') {
    return;
  }

  console.log(`[mfk][debug] ${event} ${JSON.stringify(payload)}`);
}