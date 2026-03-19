import { normalizeRequestLogRecord } from './db/client.js';
import { getEngine } from './engines/index.js';
import { collectEvents } from './ir.js';
import { buildProviderUrl, emitDumpError, emitDumpRequestLine, emitDumpResponse, extractPromptText, finalizeDump } from './lib/http.js';
import { isCooldownActive, computeNextBoundary } from './lib/time.js';
import { normalizeModelId, resolveNearestProviderModel, resolveProviderModel } from './lib/models.js';

export async function route({ config, db, ir, inboundEngine, alias, dump, onRequestLog }) {
  const candidates = selectCandidates(config, db, ir);
  const requestedAt = new Date().toISOString();
  debugLog('route', {
    model: ir.model,
    normalizedModel: normalizeModelId(ir.model),
    provider: ir.provider ?? null,
    alias,
    candidateCount: candidates.length,
  });

  if (candidates.length === 0) {
    writeRequestLog(db, {
      requestedAt,
      alias,
      requestModel: ir.model,
      status: 'no_candidate',
      errorType: 'routing',
      errorMessage: `No provider is configured for model ${ir.model}`,
    }, onRequestLog);
    emitDumpRequestLine(dump, {
      requestedModel: ir.model,
      selectedModel: ir.model,
      request: ir,
      promptText: extractPromptText(ir),
      promptChars: extractPromptText(ir).length,
    });
    emitDumpError(dump, 'routing', `No provider is configured for model ${ir.model}`);
    finalizeDump(dump);

    const error = new Error(`No provider is configured for model ${ir.model}`);
    error.statusCode = 404;
    throw error;
  }

  let lastError = null;
  let lastFailure = null;

  for (const candidate of candidates) {
    const startedAt = Date.now();
    try {
      const outboundEngine = getEngine(candidate.provider.type);
      const routedIr = candidate.model === ir.model ? ir : { ...ir, model: candidate.model };
      const promptText = extractPromptText(routedIr);
      emitDumpRequestLine(dump, {
        requestedModel: ir.model,
        selectedModel: candidate.model,
        selectedKeyValue: candidate.key.value,
        request: routedIr,
        promptText,
        promptChars: promptText.length,
      });
      const { url, headers } = buildFetch(outboundEngine, routedIr, candidate.provider, candidate.key);
      const body = outboundEngine.buildReq(routedIr);
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

      const irEvents = tapDumpEvents(outboundEngine.parse(response, url), dump);
      const message = await collectEvents(irEvents);
      const usage = message.usage ?? null;
      const result = inboundEngine.buildRes(message);
      finalizeDump(dump, usage);

      db.markSuccess(candidate.key.name);
      writeRequestLog(db, {
        requestedAt,
        alias,
        requestModel: ir.model,
        selectedKey: candidate.key.name,
        status: 'success',
        latencyMs: Date.now() - startedAt,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      }, onRequestLog);
      return result;
    } catch (error) {
      lastError = error;
      const errorType = error.errorType ?? 'fatal';
      lastFailure = {
        selectedModel: candidate.model,
        selectedKeyValue: candidate.key.value,
        errorType,
        errorMessage: error.message,
      };
      emitDumpError(dump, errorType, error.message);
      finalizeDump(dump);
      const disabledUntil = shouldDisable(errorType)
        ? computeNextBoundary(errorType === 'quota' ? candidate.provider.quotaReset : candidate.provider.failureReset)
        : null;

      db.markFailure(candidate.key.name, {
        disabledUntil,
        reason: errorType,
        message: error.message,
      });
      writeRequestLog(db, {
        requestedAt,
        alias,
        requestModel: ir.model,
        selectedKey: candidate.key.name,
        status: 'upstream_error',
        errorType,
        errorMessage: error.message,
        latencyMs: Date.now() - startedAt,
      }, onRequestLog);

      if (!error.retryable) {
        continue;
      }
    }
  }

  const error = new Error(lastError?.message ?? 'All candidate providers failed');
  error.statusCode = lastError?.statusCode ?? 503;
  throw error;
}

export async function routeStream({ config, db, ir, reply, inboundEngine, alias, dump, onRequestLog }) {
  const candidates = selectCandidates(config, db, ir);
  const requestedAt = new Date().toISOString();
  debugLog('route_stream', {
    model: ir.model,
    normalizedModel: normalizeModelId(ir.model),
    provider: ir.provider ?? null,
    alias,
    candidateCount: candidates.length,
  });

  if (candidates.length === 0) {
    emitDumpRequestLine(dump, {
      requestedModel: ir.model,
      selectedModel: ir.model,
      request: ir,
      promptText: extractPromptText(ir),
      promptChars: extractPromptText(ir).length,
    });
    emitDumpError(dump, 'routing', `No provider is configured for model ${ir.model}`);
    finalizeDump(dump);
    const error = new Error(`No provider is configured for model ${ir.model}`);
    error.statusCode = 404;
    throw error;
  }

  let lastError = null;
  let lastFailure = null;

  for (const candidate of candidates) {
    const startedAt = Date.now();
    let emittedData = false;

    try {
      const outboundEngine = getEngine(candidate.provider.type);
      const streamIr = candidate.model === ir.model
        ? { ...ir, stream: true }
        : { ...ir, model: candidate.model, stream: true };
      const promptText = extractPromptText(streamIr);
      emitDumpRequestLine(dump, {
        requestedModel: ir.model,
        selectedModel: candidate.model,
        selectedKeyValue: candidate.key.value,
        request: streamIr,
        promptText,
        promptChars: promptText.length,
      });
      const { url, headers } = buildFetch(outboundEngine, streamIr, candidate.provider, candidate.key);
      const body = outboundEngine.buildReq(streamIr);
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

      let finalMessage = null;
      const irEvents = tapDumpEvents(
        captureFinalMessage(outboundEngine.parse(response, url), (message) => {
          finalMessage = message;
        }),
        dump,
      );
      await inboundEngine.writeStream(reply, irEvents, ir);
      const usage = finalMessage?.usage ?? null;
      emittedData = true;
      finalizeDump(dump, usage);

      db.markSuccess(candidate.key.name);
      writeRequestLog(db, {
        requestedAt,
        alias,
        requestModel: ir.model,
        selectedKey: candidate.key.name,
        status: 'success',
        latencyMs: Date.now() - startedAt,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      }, onRequestLog);
      return;
    } catch (error) {
      lastError = error;
      const errorType = error.errorType ?? 'fatal';
      lastFailure = {
        selectedModel: candidate.model,
        selectedKeyValue: candidate.key.value,
        errorType,
        errorMessage: error.message,
      };
      emitDumpError(dump, errorType, error.message);
      finalizeDump(dump);
      const disabledUntil = shouldDisable(errorType)
        ? computeNextBoundary(errorType === 'quota' ? candidate.provider.quotaReset : candidate.provider.failureReset)
        : null;

      db.markFailure(candidate.key.name, {
        disabledUntil,
        reason: errorType,
        message: error.message,
      });
      writeRequestLog(db, {
        requestedAt,
        alias,
        requestModel: ir.model,
        selectedKey: candidate.key.name,
        status: 'upstream_error',
        errorType,
        errorMessage: error.message,
        latencyMs: Date.now() - startedAt,
      }, onRequestLog);

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

async function* captureFinalMessage(eventStream, onMessage) {
  for await (const event of eventStream) {
    if (event.type === 'message') {
      onMessage(event);
    }

    yield event;
  }
}

async function* tapDumpEvents(eventStream, dump) {
  let sawDelta = false;

  for await (const event of eventStream) {
    if (event.type === 'delta' && event.text) {
      sawDelta = true;
      emitDumpResponse(dump, event.text);
    } else if (event.type === 'message' && event.content && !sawDelta) {
      emitDumpResponse(dump, event.content);
    }

    yield event;
  }
}

function writeRequestLog(db, record, onRequestLog) {
  const row = normalizeRequestLogRecord(record);
  db.logRequest(record);
  onRequestLog?.(row);
  return row;
}

export function selectCandidates(config, db, ir) {
  const now = new Date();
  const requestedProvider = ir.provider?.trim();
  const exactCandidates = [];
  const availableProviders = [];

  for (const provider of config.providers) {
    if (requestedProvider && !matchesProviderSelector(provider, requestedProvider)) {
      continue;
    }

    const key = provider.key;
    const state = db.getKeyState(key.name);
    if (isCooldownActive(state?.disabled_until, now)) {
      continue;
    }

    availableProviders.push({
      provider,
      key,
      keyState: state,
    });

    const model = provider.models.length === 0 ? ir.model : resolveProviderModel(provider, ir.model);
    if (!model) {
      continue;
    }

    exactCandidates.push({
      provider,
      key,
      keyState: state,
      model,
      tierDistance: 0,
    });
  }

  if (exactCandidates.length > 0 || requestedProvider) {
    return exactCandidates.sort(compareCandidates);
  }

  const fallbackCandidates = availableProviders
    .map((candidate) => {
      const nearestModel = resolveNearestProviderModel(config.modelTier, candidate.provider, ir.model);
      if (!nearestModel) {
        return null;
      }

      return {
        ...candidate,
        model: nearestModel.model,
        tierDistance: nearestModel.distance,
        tierIndex: nearestModel.tierIndex,
      };
    })
    .filter(Boolean);

  return fallbackCandidates.sort(compareCandidates);
}

function compareCandidates(left, right) {
  if ((left.tierDistance ?? 0) !== (right.tierDistance ?? 0)) {
    return (left.tierDistance ?? 0) - (right.tierDistance ?? 0);
  }

  if ((left.tierIndex ?? Number.MAX_SAFE_INTEGER) !== (right.tierIndex ?? Number.MAX_SAFE_INTEGER)) {
    return (left.tierIndex ?? Number.MAX_SAFE_INTEGER) - (right.tierIndex ?? Number.MAX_SAFE_INTEGER);
  }

  if (left.provider.priority !== right.provider.priority) {
    return left.provider.priority - right.provider.priority;
  }

  return left.key.priority - right.key.priority;
}

function shouldDisable(errorType) {
  return errorType === 'quota' || errorType === 'retryable' || errorType === 'auth';
}

function matchesProviderSelector(provider, selector) {
  return selector === provider.type
    || selector === provider.baseUrl
    || selector === provider.apiKey
    || selector === provider.id
    || selector === String(provider.order + 1);
}

function debugLog(event, payload) {
  if (process.env.MFK_DEBUG !== '1') {
    return;
  }

  console.log(`[mfk][debug] ${event} ${JSON.stringify(payload)}`);
}