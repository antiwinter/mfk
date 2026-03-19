import Fastify from 'fastify';
import { parseVirtualKey } from '../lib/virtualKey.js';
import { openaiEngine, anthropicEngine, googleEngine } from '../engines/index.js';
import { getCapabilityModels } from '../lib/models.js';
import { route, routeStream } from '../router.js';

export function createServer({ config, db }) {
  const app = Fastify({ logger: false });

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

  // --- Model listing ---

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
    return handleCompletion(request, reply, openaiEngine, config, db);
  });

  app.post('/v1/messages', async (request, reply) => {
    return handleCompletion(request, reply, anthropicEngine, config, db);
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
    });
  });

  app.setNotFoundHandler(async (request, reply) => {
    debugLog('not_found', { method: request.method, url: request.url });
    reply.code(404);
    return { error: { message: `Route not found: ${request.method} ${request.url}` } };
  });

  return app;
}

async function handleCompletion(request, reply, inboundEngine, config, db, parseParams) {
  try {
    const virtualKey = parseVirtualKey(request.headers);
    const body = request.body ?? {};
    const ir = parseParams
      ? inboundEngine.parseReq(body, parseParams)
      : inboundEngine.parseReq(body);

    ir.provider = request.headers['x-mfk-provider'] ?? ir.provider;

    debugLog('request', {
      engine: inboundEngine.type,
      model: ir.model,
      stream: ir.stream,
      username: virtualKey.username,
    });

    if (!ir.model) {
      reply.code(400);
      return buildErrorResponse(inboundEngine.type, { message: 'Request body must include model' });
    }

    if (ir.stream) {
      try {
        await routeStream({
          config,
          db,
          ir,
          reply,
          inboundEngine,
          username: virtualKey.username,
          virtualKey: virtualKey.token,
          originalBody: body,
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
      username: virtualKey.username,
      virtualKey: virtualKey.token,
      originalBody: body,
    });
  } catch (error) {
    debugLog('error', { engine: inboundEngine.type, message: error.message, statusCode: error.statusCode ?? 400 });
    reply.code(error.statusCode ?? 400);
    return buildErrorResponse(inboundEngine.type, error);
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