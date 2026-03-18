import { getEngine } from './engines/index.js';
import { collectEvents } from './ir.js';
import { buildProviderUrl, readJsonError } from './lib/http.js';
import { isCooldownActive, computeNextBoundary } from './lib/time.js';

export async function route({ config, db, ir, inboundEngine, username, virtualKey, echo, originalBody }) {
  const candidates = selectCandidates(config, db, ir);
  const requestedAt = new Date().toISOString();
  debugLog('route', {
    model: ir.model,
    normalizedModel: normalizeModelId(ir.model),
    provider: ir.provider ?? null,
    username,
    candidateCount: candidates.length,
  });

  if (candidates.length === 0) {
    db.logRequest({
      requestedAt,
      username,
      virtualKey,
      requestModel: ir.model,
      requestedProvider: ir.provider,
      status: 'no_candidate',
      errorType: 'routing',
      errorMessage: `No provider is configured for model ${ir.model}`,
    });

    const error = new Error(`No provider is configured for model ${ir.model}`);
    error.statusCode = 404;
    throw error;
  }

  let lastError = null;

  for (const candidate of candidates) {
    const startedAt = Date.now();
    try {
      const outboundEngine = getEngine(candidate.provider.type);
      const passthrough = inboundEngine.type === outboundEngine.type;
      const { url, headers } = buildFetch(outboundEngine, ir, candidate.provider, candidate.key);
      const body = passthrough ? originalBody : outboundEngine.buildReq(ir);
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

      let result;
      if (passthrough) {
        if (!response.ok) await readJsonError(response, url);
        result = await response.json();
      } else {
        const irEvents = outboundEngine.parse(response, url);
        const message = await collectEvents(irEvents);
        result = inboundEngine.buildRes(message);
      }

      db.markSuccess(candidate.provider.id, candidate.key.name);
      db.logRequest({
        requestedAt,
        username,
        virtualKey,
        requestModel: ir.model,
        requestedProvider: ir.provider,
        selectedProvider: candidate.provider.id,
        selectedKey: candidate.key.name,
        status: 'success',
        latencyMs: Date.now() - startedAt,
      });
      return result;
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
        requestModel: ir.model,
        requestedProvider: ir.provider,
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

export async function routeStream({ config, db, ir, reply, inboundEngine, username, virtualKey, originalBody }) {
  const candidates = selectCandidates(config, db, ir);
  const requestedAt = new Date().toISOString();
  debugLog('route_stream', {
    model: ir.model,
    normalizedModel: normalizeModelId(ir.model),
    provider: ir.provider ?? null,
    username,
    candidateCount: candidates.length,
  });

  if (candidates.length === 0) {
    const error = new Error(`No provider is configured for model ${ir.model}`);
    error.statusCode = 404;
    throw error;
  }

  let lastError = null;

  for (const candidate of candidates) {
    const startedAt = Date.now();
    let emittedData = false;

    try {
      const outboundEngine = getEngine(candidate.provider.type);
      const passthrough = inboundEngine.type === outboundEngine.type;
      const streamIr = { ...ir, stream: true };
      const { url, headers } = buildFetch(outboundEngine, streamIr, candidate.provider, candidate.key);
      const body = passthrough ? originalBody : outboundEngine.buildReq(streamIr);
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

      if (passthrough) {
        if (!response.ok) await readJsonError(response, url);
        await pipeStream(reply, response);
      } else {
        const irEvents = outboundEngine.parse(response, url);
        await inboundEngine.writeStream(reply, irEvents, ir);
      }
      emittedData = true;

      db.markSuccess(candidate.provider.id, candidate.key.name);
      db.logRequest({
        requestedAt,
        username,
        virtualKey,
        requestModel: ir.model,
        requestedProvider: ir.provider,
        selectedProvider: candidate.provider.id,
        selectedKey: candidate.key.name,
        status: 'success',
        latencyMs: Date.now() - startedAt,
      });
      return;
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
        requestModel: ir.model,
        requestedProvider: ir.provider,
        selectedProvider: candidate.provider.id,
        selectedKey: candidate.key.name,
        status: 'failed',
        errorType,
        errorMessage: error.message,
        latencyMs: Date.now() - startedAt,
      });

      if (emittedData || !error.retryable) {
        break;
      }
    }
  }

  const error = new Error(lastError?.message ?? 'All candidate providers failed');
  error.statusCode = lastError?.statusCode ?? 503;
  throw error;
}

// Also export a simple invoke helper for discovery probing (non-stream, returns IR message)
export async function invokeEngine(engine, provider, key, ir) {
  const { url, headers } = buildFetch(engine, ir, provider, key);
  const body = engine.buildReq(ir);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return collectEvents(engine.parse(response, url));
}

function buildFetch(engine, ir, provider, key) {
  const url = buildProviderUrl(provider.baseUrl, engine.endpoint(ir, key));
  const headers = engine.buildHeaders(provider, key);
  return { url, headers };
}

async function pipeStream(reply, response) {
  reply.raw.setHeader('content-type', response.headers.get('content-type') ?? 'text/event-stream');
  reply.raw.setHeader('cache-control', 'no-cache');
  reply.raw.setHeader('connection', 'keep-alive');
  reply.hijack();

  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      reply.raw.write(value);
    }
  } finally {
    reply.raw.end();
  }
}

function selectCandidates(config, db, ir) {
  const now = new Date();
  const requestedProvider = ir.provider?.trim();
  const candidates = [];

  for (const provider of config.providers) {
    if (requestedProvider && !matchesProviderSelector(provider, requestedProvider)) {
      continue;
    }

    const supportsModel = provider.models.length === 0 || providerSupportsModel(provider, ir.model);
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