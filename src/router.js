import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { normalizeRequestLogRecord } from './db/client.js';
import { getEngine } from './engines/index.js';
import { collectEvents } from './ir.js';
import { buildProviderUrl, createUpstreamError } from './lib/http.js';
import { emitError, emitRequest, emitResponse, finalize, extractPromptText } from './lib/dump.js';
import { isCooldownActive, computeNextBoundary } from './lib/time.js';
import { normalizeModelId, resolveNearestProviderModel, resolveProviderModel } from './lib/models.js';

export async function route({ config, db, ir, inboundEngine, virtualKey, dump, onRequestLog }) {
  const candidates = selectCandidates(config, db, ir);
  const requestedAt = new Date().toISOString();
  debugLog('route', {
    model: ir.model,
    normalizedModel: normalizeModelId(ir.model),
    provider: ir.provider ?? null,
    virtualKey,
    candidateCount: candidates.length,
  });

  if (candidates.length === 0) {
    writeRequestLog(db, {
      requestedAt,
      virtualKey,
      requestModel: ir.model,
      status: 'no_candidate',
      errorType: 'routing',
      errorMessage: `No provider is configured for model ${ir.model}`,
    }, onRequestLog);
    emitRequest(dump, {
      requestedModel: ir.model,
      selectedModel: ir.model,
      request: ir,
      promptText: extractPromptText(ir),
      promptChars: extractPromptText(ir).length,
    });
    emitError(dump, 'routing', `No provider is configured for model ${ir.model}`);
    finalize(dump);

    const error = new Error(`No provider is configured for model ${ir.model}`);
    error.statusCode = 404;
    throw error;
  }

  const candidate = candidates[0];
  const startedAt = Date.now();

  try {
    const outboundEngine = getEngine(candidate.provider.type);
    const routedIr = candidate.model === ir.model ? ir : { ...ir, model: candidate.model };
    const promptText = extractPromptText(routedIr);
    emitRequest(dump, {
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
    finalize(dump, usage);

    db.markSuccess(candidate.key.name);
    writeRequestLog(db, {
      requestedAt,
      virtualKey,
      requestModel: ir.model,
      selectedKey: candidate.key.name,
      status: 'success',
      latencyMs: Date.now() - startedAt,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    }, onRequestLog);
    return result;
  } catch (error) {
    const errorType = error.errorType ?? 'fatal';
    emitError(dump, errorType, error.message);
    finalize(dump);
    const disabledUntil = computeNextBoundary(
      errorType === 'quota' ? candidate.provider.quotaReset : candidate.provider.failureReset,
    );

    db.markFailure(candidate.key.name, {
      disabledUntil,
      reason: errorType,
      message: error.message,
    });
    writeRequestLog(db, {
      requestedAt,
      virtualKey,
      requestModel: ir.model,
      selectedKey: candidate.key.name,
      status: 'upstream_error',
      errorType,
      errorMessage: error.message,
      latencyMs: Date.now() - startedAt,
    }, onRequestLog);
    throw error;
  }
}

export async function routeStream({ config, db, ir, reply, inboundEngine, virtualKey, dump, onRequestLog }) {
  const candidates = selectCandidates(config, db, ir);
  const requestedAt = new Date().toISOString();
  debugLog('route_stream', {
    model: ir.model,
    normalizedModel: normalizeModelId(ir.model),
    provider: ir.provider ?? null,
    virtualKey,
    candidateCount: candidates.length,
  });

  if (candidates.length === 0) {
    emitRequest(dump, {
      requestedModel: ir.model,
      selectedModel: ir.model,
      request: ir,
      promptText: extractPromptText(ir),
      promptChars: extractPromptText(ir).length,
    });
    emitError(dump, 'routing', `No provider is configured for model ${ir.model}`);
    finalize(dump);
    const error = new Error(`No provider is configured for model ${ir.model}`);
    error.statusCode = 404;
    throw error;
  }

  const candidate = candidates[0];
  const startedAt = Date.now();

  try {
    const outboundEngine = getEngine(candidate.provider.type);
    const streamIr = candidate.model === ir.model
      ? { ...ir, stream: true }
      : { ...ir, model: candidate.model, stream: true };
    const promptText = extractPromptText(streamIr);
    emitRequest(dump, {
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
    finalize(dump, usage);

    db.markSuccess(candidate.key.name);
    writeRequestLog(db, {
      requestedAt,
      virtualKey,
      requestModel: ir.model,
      selectedKey: candidate.key.name,
      status: 'success',
      latencyMs: Date.now() - startedAt,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    }, onRequestLog);
    return;
  } catch (error) {
    const errorType = error.errorType ?? 'fatal';
    emitError(dump, errorType, error.message);
    finalize(dump);
    const disabledUntil = computeNextBoundary(
      errorType === 'quota' ? candidate.provider.quotaReset : candidate.provider.failureReset,
    );

    db.markFailure(candidate.key.name, {
      disabledUntil,
      reason: errorType,
      message: error.message,
    });
    writeRequestLog(db, {
      requestedAt,
      virtualKey,
      requestModel: ir.model,
      selectedKey: candidate.key.name,
      status: 'upstream_error',
      errorType,
      errorMessage: error.message,
      latencyMs: Date.now() - startedAt,
    }, onRequestLog);
    throw error;
  }
}

export async function routePassthrough({
  candidate,
  db,
  dump,
  inboundEngine,
  ir,
  rawBody,
  reply,
  virtualKey,
  onRequestLog,
}) {
  const requestedAt = new Date().toISOString();
  const startedAt = Date.now();
  const selectedModel = candidate.model;
  const passthroughIr = selectedModel === ir.model ? ir : { ...ir, model: selectedModel };
  const promptText = extractPromptText(ir);

  emitRequest(dump, {
    requestedModel: ir.model,
    selectedModel,
    selectedKeyValue: candidate.key.value,
    request: ir,
    promptText,
    promptChars: promptText.length,
  });

  try {
    const { url, headers } = buildFetch(inboundEngine, passthroughIr, candidate.provider, candidate.key);
    const body = buildPassthroughBody(inboundEngine.type, rawBody, ir, selectedModel);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

    if (!response.ok) {
      const upstream = await readUpstreamBody(response);
      const error = createUpstreamError(url, response.status, upstream.body);
      emitError(dump, error.errorType, error.message);
      finalize(dump);
      markFailure(db, candidate, error);
      writeRequestLog(db, {
        requestedAt,
        virtualKey,
        requestModel: ir.model,
        selectedKey: candidate.key.name,
        status: 'upstream_error',
        errorType: error.errorType,
        errorMessage: error.message,
        latencyMs: Date.now() - startedAt,
      }, onRequestLog);
      reply.code(response.status);
      copyResponseHeaders(reply, response);
      return reply.send(upstream.rawText);
    }

    if (ir.stream && isEventStream(response) && response.body) {
      const dumpPromise = collectPassthroughDump(inboundEngine, response.clone(), url, dump);
      reply.hijack();
      reply.raw.statusCode = response.status;
      copyResponseHeaders(reply, response);
      Readable.fromWeb(response.body).pipe(reply.raw);
      await finished(reply.raw);
      const usage = await dumpPromise;
      finalize(dump, usage);
      db.markSuccess(candidate.key.name);
      writeRequestLog(db, {
        requestedAt,
        virtualKey,
        requestModel: ir.model,
        selectedKey: candidate.key.name,
        status: 'success',
        latencyMs: Date.now() - startedAt,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      }, onRequestLog);
      return reply;
    }

    const dumpPromise = collectPassthroughDump(inboundEngine, response.clone(), url, dump)
      .catch(() => null);
    const upstream = await readUpstreamBody(response);
    const usage = await dumpPromise;
    finalize(dump, usage);
    db.markSuccess(candidate.key.name);
    writeRequestLog(db, {
      requestedAt,
      virtualKey,
      requestModel: ir.model,
      selectedKey: candidate.key.name,
      status: 'success',
      latencyMs: Date.now() - startedAt,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    }, onRequestLog);
    reply.code(response.status);
    copyResponseHeaders(reply, response);
    return reply.send(upstream.rawText);
  } catch (error) {
    emitError(dump, error.errorType ?? 'fatal', error.message);
    finalize(dump);
    markFailure(db, candidate, error);
    writeRequestLog(db, {
      requestedAt,
      virtualKey,
      requestModel: ir.model,
      selectedKey: candidate.key.name,
      status: 'upstream_error',
      errorType: error.errorType ?? 'fatal',
      errorMessage: error.message,
      latencyMs: Date.now() - startedAt,
    }, onRequestLog);
    throw error;
  }
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
      emitResponse(dump, event.text);
    } else if (event.type === 'message' && event.content && !sawDelta) {
      emitResponse(dump, event.content);
    }

    yield event;
  }
}

async function collectPassthroughDump(engine, response, url, dump) {
  if (!dump?.enabled) {
    return null;
  }

  const message = await collectEvents(tapDumpEvents(engine.parse(response, url), dump));
  return message.usage ?? null;
}

async function readUpstreamBody(response) {
  const rawText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const body = !rawText
    ? null
    : contentType.includes('application/json')
      ? JSON.parse(rawText)
      : { text: rawText };

  return { rawText, body };
}

function buildPassthroughBody(engineType, rawBody, ir, selectedModel) {
  const body = structuredClone(rawBody ?? {});
  if (selectedModel === ir.model) {
    return body;
  }

  if (engineType === 'google') {
    return body;
  }

  body.model = engineType === 'anthropic'
    ? normalizeModelId(selectedModel)
    : selectedModel;
  return body;
}

function copyResponseHeaders(reply, response) {
  response.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (normalized === 'connection' || normalized === 'content-length' || normalized === 'transfer-encoding') {
      return;
    }
    reply.raw.setHeader(key, value);
  });
}

function isEventStream(response) {
  return (response.headers.get('content-type') ?? '').includes('text/event-stream');
}

function markFailure(db, candidate, error) {
  const errorType = error.errorType ?? 'fatal';
  const disabledUntil = computeNextBoundary(
    errorType === 'quota' ? candidate.provider.quotaReset : candidate.provider.failureReset,
  );

  db.markFailure(candidate.key.name, {
    disabledUntil,
    reason: errorType,
    message: error.message,
  });
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
