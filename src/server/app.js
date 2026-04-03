import Fastify from 'fastify';
import { createDump, emitError, emitRequest, finalize, extractPromptText } from '../lib/dump.js';
import { extractVirtualKeyToken } from '../lib/virtualKey.js';
import { openaiEngine, anthropicEngine, googleEngine } from '../engines/index.js';
import { getCapabilityModels, getCapabilityModelInfos } from '../lib/models.js';
import { route, routePassthrough, routeStream, selectCandidates } from '../router.js';

export function createServer({ config, db, dump = false, dumpWrite, onRequestLog }) {
  const app = Fastify({ logger: false });
  const dumpLineWriter = dumpWrite ?? ((text) => process.stdout.write(text));

  app.addHook('onRequest', async (request) => {
    debugLog('incoming_request', {
      method: request.method,
      url: request.url,
      hasAuthorization: Boolean(request.headers.authorization),
      hasApiKey: Boolean(request.headers['x-api-key']),
      anthropicVersion: request.headers['anthropic-version'] ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // /v1/models/info — OpenClaw plugin discovery: model list with per-model apiType.
  // No auth required (local metadata only).
  app.get('/v1/models/info', async () => {
    return { models: getCapabilityModelInfos(config) };
  });

  app.get('/v1/models', async (request) => {
    const models = getCapabilityModels(config);

    if (isAnthropicRequest(request.headers)) {
      const anthropicModels = [...new Set(models.map(stripAnthropicPrefix))];
      return {
        data: anthropicModels.map((id) => ({
          id,
          type: 'model',
          display_name: id,
          created_at: '1970-01-01T00:00:00Z',
        })),
        first_id: anthropicModels[0] ?? null,
        has_more: false,
        last_id: anthropicModels.at(-1) ?? null,
      };
    }

    return {
      object: 'list',
      data: models.map((id) => ({ id, object: 'model', owned_by: 'mfk' })),
    };
  });

  app.get('/v1beta/models', async () => {
    const models = getCapabilityModels(config);

    return {
      models: models.map((id) => ({
        name: `models/${id}`,
        displayName: id,
        supportedGenerationMethods: ['generateContent'],
      })),
    };
  });

  // --- Completion endpoints ---

  app.post('/v1/chat/completions', async (request, reply) => {
    return handleCompletion(request, reply, openaiEngine, config, db, null, {
      dump,
      dumpWrite: dumpLineWriter,
      onRequestLog,
    });
  });

  app.post('/v1/messages', async (request, reply) => {
    return handleCompletion(request, reply, anthropicEngine, config, db, null, {
      dump,
      dumpWrite: dumpLineWriter,
      onRequestLog,
    });
  });

  app.post('/v1beta/models/:modelAction', async (request, reply) => {
    const { modelAction } = request.params;
    const colonIdx = modelAction.lastIndexOf(':');
    if (colonIdx === -1) {
      reply.code(400);
      return { error: { message: 'Invalid Google endpoint. Expected :generateContent or :streamGenerateContent' } };
    }

    const model = modelAction.slice(0, colonIdx);
    const action = modelAction.slice(colonIdx + 1);

    if (action !== 'generateContent' && action !== 'streamGenerateContent') {
      reply.code(400);
      return { error: { message: `Unsupported action: ${action}` } };
    }

    return handleCompletion(request, reply, googleEngine, config, db, {
      model,
      stream: action === 'streamGenerateContent',
    }, {
      dump,
      dumpWrite: dumpLineWriter,
      onRequestLog,
    });
  });

  app.setNotFoundHandler(async (request, reply) => {
    debugLog('not_found', { method: request.method, url: request.url });
    reply.code(404);
    return { error: { message: `Route not found: ${request.method} ${request.url}` } };
  });

  return app;
}

async function handleCompletion(request, reply, inboundEngine, config, db, parseParams, runtime = {}) {
  const dump = createDump({
    enabled: runtime.dump,
    write: runtime.dumpWrite,
  });
  const body = request.body ?? {};
  const previewIr = tryParseIr(inboundEngine, body, parseParams);

  try {
    const token = extractVirtualKeyToken(request.headers);
    const virtualKey = db.findVirtualKeyByToken(token);
    if (!virtualKey) {
      const error = new Error('Unknown virtual key');
      error.statusCode = 401;
      error.errorType = 'auth_error';
      throw error;
    }

    const ir = previewIr ?? (parseParams
      ? inboundEngine.parseReq(body, parseParams)
      : inboundEngine.parseReq(body));

    ir.provider = request.headers['x-mfk-provider'] ?? ir.provider;

    debugLog('request', {
      engine: inboundEngine.type,
      model: ir.model,
      stream: ir.stream,
      alias: virtualKey.alias,
    });

    if (!ir.model) {
      reply.code(400);
      return buildErrorResponse(inboundEngine.type, { message: 'Request body must include model' });
    }

    const candidates = selectCandidates(config, db, ir);
    const candidate = candidates[0] ?? null;

    if (candidate?.provider.type === inboundEngine.type) {
      return await routePassthrough({
        candidate,
        db,
        dump,
        inboundEngine,
        ir,
        rawBody: body,
        reply,
        virtualKey: virtualKey.virtual_key,
        onRequestLog: runtime.onRequestLog,
      });
    }

    if (ir.stream) {
      try {
        await routeStream({
          config,
          db,
          ir,
          reply,
          inboundEngine,
          virtualKey: virtualKey.virtual_key,
          dump,
          onRequestLog: runtime.onRequestLog,
        });
        return reply;
      } catch (error) {
        debugLog('stream_error', { message: error.message, statusCode: error.statusCode ?? 500 });
        reply.code(error.statusCode ?? 500);
        return buildErrorResponse(inboundEngine.type, error);
      }
    }

    return await route({
      config,
      db,
      ir,
      inboundEngine,
      virtualKey: virtualKey.virtual_key,
      dump,
      onRequestLog: runtime.onRequestLog,
    });
  } catch (error) {
    debugLog('error', { engine: inboundEngine.type, message: error.message, statusCode: error.statusCode ?? 400 });
    if (previewIr) {
      const promptText = extractPromptText(previewIr);
      emitRequest(dump, {
        requestedModel: previewIr.model,
        selectedModel: previewIr.model,
        request: previewIr,
        promptText,
        promptChars: promptText.length,
      });
    }
    emitError(dump, error.errorType ?? 'request_error', error.message);
    finalize(dump);
    reply.code(error.statusCode ?? 400);
    return buildErrorResponse(inboundEngine.type, error);
  }
}

function tryParseIr(inboundEngine, body, parseParams) {
  try {
    return parseParams
      ? inboundEngine.parseReq(body, parseParams)
      : inboundEngine.parseReq(body);
  } catch {
    return null;
  }
}

function buildErrorResponse(engineType, error) {
  if (engineType === 'anthropic') {
    return {
      type: 'error',
      error: { type: error.errorType ?? 'request_error', message: error.message },
    };
  }

  return {
    error: { message: error.message, type: error.errorType ?? 'request_error' },
  };
}

function isAnthropicRequest(headers) {
  return Boolean(headers['x-api-key'] || headers['anthropic-version']);
}

function stripAnthropicPrefix(model) {
  return String(model ?? '').replace(/^anthropic\//, '');
}

function debugLog(event, payload) {
  if (process.env.MFK_DEBUG !== '1') return;
  console.log(`[mfk][debug] ${event} ${JSON.stringify(payload)}`);
}
