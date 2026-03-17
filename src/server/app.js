import Fastify from 'fastify';
import { parseVirtualKey } from '../lib/virtualKey.js';
import { normalizeOpenAiRequest } from '../providers/shared.js';
import { routeRequest } from '../routing/router.js';

export function createServer({ config, db }) {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/v1/models', async () => {
    const models = [...new Set(config.providers.flatMap((provider) => provider.models ?? []))];
    return {
      object: 'list',
      data: models.map((modelId) => ({
        id: modelId,
        object: 'model',
        owned_by: 'mfk',
      })),
    };
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    try {
      const virtualKey = parseVirtualKey(request.headers.authorization);
      const normalized = normalizeOpenAiRequest(request.body ?? {});
      normalized.provider = request.headers['x-mfk-provider'] ?? normalized.provider;

      if (!normalized.model) {
        reply.code(400);
        return { error: { message: 'Request body must include model' } };
      }

      if (normalized.stream) {
        reply.code(501);
        return { error: { message: 'Streaming is not implemented yet' } };
      }

      const response = await routeRequest({
        config,
        db,
        request: normalized,
        username: virtualKey.username,
        virtualKey: virtualKey.token,
      });

      return response;
    } catch (error) {
      reply.code(error.statusCode ?? 400);
      return {
        error: {
          message: error.message,
          type: error.errorType ?? 'request_error',
        },
      };
    }
  });

  return app;
}