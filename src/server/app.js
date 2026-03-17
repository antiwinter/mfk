import Fastify from 'fastify';
import { parseVirtualKey } from '../lib/virtualKey.js';
import { normalizeOpenAiRequest } from '../providers/shared.js';
import { routeRequest, routeRequestStream } from '../routing/router.js';

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

  app.get('/v1/models', async (request) => {
    const models = [...new Set(config.providers.flatMap((provider) => provider.models ?? []))]
      .filter((model) => model !== '*' && !String(model).endsWith('/*'));

    if (isAnthropicRequest(request.headers)) {
      const anthropicModels = [...new Set(models.map(toAnthropicModelId))];
      debugLog('models_response', {
        style: 'anthropic',
        count: anthropicModels.length,
        models: anthropicModels,
      });
      return {
        data: anthropicModels.map((modelId) => ({
          id: modelId,
          type: 'model',
          display_name: modelId,
          created_at: '1970-01-01T00:00:00Z',
        })),
        first_id: anthropicModels[0] ?? null,
        has_more: false,
        last_id: anthropicModels.at(-1) ?? null,
      };
    }

    debugLog('models_response', {
      style: 'openai',
      count: models.length,
      models,
    });
    return {
      object: 'list',
      data: models.map((modelId) => ({
        id: modelId,
        object: 'model',
        owned_by: 'mfk',
      })),
    };
  });

  app.post('/v1/messages', async (request, reply) => {
    try {
      const virtualKey = parseVirtualKey(request.headers);
      const body = request.body ?? {};
      const normalized = normalizeAnthropicRequest(body);
      normalized.provider = request.headers['x-mfk-provider'] ?? normalized.provider;

      debugLog('anthropic_request', {
        model: body.model ?? null,
        normalizedModel: normalized.model,
        stream: normalized.stream,
        username: virtualKey.username,
        style: virtualKey.style,
      });

      if (!normalized.model) {
        reply.code(400);
        return { error: { message: 'Request body must include model' } };
      }

      if (normalized.stream) {
        const streamState = createAnthropicStream(reply, normalized.model);

        try {
          await routeRequestStream({
            config,
            db,
            request: normalized,
            username: virtualKey.username,
            virtualKey: virtualKey.token,
            onText: (chunk) => {
              streamState.writeText(chunk);
            },
          });
          streamState.finish();
          return reply;
        } catch (error) {
          debugLog('anthropic_stream_error', {
            message: error.message,
            statusCode: error.statusCode ?? 500,
          });
          streamState.writeError(error);
          streamState.finish();
          return reply;
        }
      }

      const response = await routeRequest({
        config,
        db,
        request: normalized,
        username: virtualKey.username,
        virtualKey: virtualKey.token,
      });

      return toAnthropicResponse(normalized.model, response);
    } catch (error) {
      debugLog('anthropic_error', {
        message: error.message,
        statusCode: error.statusCode ?? 400,
      });
      reply.code(error.statusCode ?? 400);
      return {
        type: 'error',
        error: {
          type: error.errorType ?? 'request_error',
          message: error.message,
        },
      };
    }
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    try {
      const virtualKey = parseVirtualKey(request.headers);
      const normalized = normalizeOpenAiRequest(request.body ?? {});
      normalized.provider = request.headers['x-mfk-provider'] ?? normalized.provider;

      debugLog('openai_request', {
        model: request.body?.model ?? null,
        normalizedModel: normalized.model,
        stream: normalized.stream,
        username: virtualKey.username,
        style: virtualKey.style,
      });

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
      debugLog('openai_error', {
        message: error.message,
        statusCode: error.statusCode ?? 400,
      });
      reply.code(error.statusCode ?? 400);
      return {
        error: {
          message: error.message,
          type: error.errorType ?? 'request_error',
        },
      };
    }
  });

  app.setNotFoundHandler(async (request, reply) => {
    debugLog('not_found', {
      method: request.method,
      url: request.url,
    });
    reply.code(404);
    return {
      error: {
        message: `Route not found: ${request.method} ${request.url}`,
      },
    };
  });

  return app;
}

function isAnthropicRequest(headers) {
  return Boolean(headers['x-api-key'] || headers['anthropic-version']);
}

function normalizeAnthropicRequest(body) {
  return {
    model: toAnthropicModelId(body.model),
    messages: normalizeAnthropicMessages(body.messages),
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    stream: Boolean(body.stream),
    provider: body.provider,
  };
}

function normalizeAnthropicMessages(messages) {
  return Array.isArray(messages)
    ? messages.map((message) => ({
        role: message.role,
        content: Array.isArray(message.content)
          ? message.content
              .filter((part) => part?.type === 'text')
              .map((part) => part.text ?? '')
              .join('\n')
          : message.content,
      }))
    : [];
}

function toAnthropicResponse(model, openaiResponse) {
  const text = openaiResponse?.choices?.[0]?.message?.content ?? '';
  return {
    id: openaiResponse?.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: toAnthropicModelId(model),
    content: [
      {
        type: 'text',
        text,
      },
    ],
    stop_reason: openaiResponse?.choices?.[0]?.finish_reason ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse?.usage?.prompt_tokens ?? 0,
      output_tokens: openaiResponse?.usage?.completion_tokens ?? 0,
    },
  };
}

function toAnthropicModelId(model) {
  return String(model ?? '').replace(/^anthropic\//, '');
}

function createAnthropicStream(reply, model) {
  const messageId = `msg_${Date.now()}`;
  let started = false;
  let textIndex = 0;

  reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
  reply.raw.setHeader('cache-control', 'no-cache');
  reply.raw.setHeader('connection', 'keep-alive');
  reply.hijack();

  const writeEvent = (event, data) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const start = () => {
    if (started) {
      return;
    }

    started = true;
    writeEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: toAnthropicModelId(model),
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    });
    writeEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: '',
      },
    });
  };

  return {
    writeText(chunk) {
      start();
      textIndex += chunk.length;
      writeEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: chunk,
        },
      });
    },
    writeError(error) {
      writeEvent('error', {
        type: 'error',
        error: {
          type: error.errorType ?? 'api_error',
          message: error.message,
        },
      });
    },
    finish() {
      start();
      writeEvent('content_block_stop', {
        type: 'content_block_stop',
        index: 0,
      });
      writeEvent('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: textIndex,
        },
      });
      writeEvent('message_stop', {
        type: 'message_stop',
      });
      reply.raw.end();
    },
  };
}

function debugLog(event, payload) {
  if (process.env.MFK_DEBUG !== '1') {
    return;
  }

  console.log(`[mfk][debug] ${event} ${JSON.stringify(payload)}`);
}