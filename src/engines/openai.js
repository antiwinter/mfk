import { createIR, createDelta, createMessage, flattenMessageContent, normalizeMessageContent } from '../ir.js';
import { buildProviderUrl, requestJson, readJsonError, uniqueModels } from '../lib/http.js';

export const openaiEngine = {
  type: 'openai',

  parseReq(body) {
    return createIR({
      model: body.model,
      messages: Array.isArray(body.messages) ? body.messages : [],
      temperature: body.temperature,
      maxTokens: body.max_completion_tokens ?? body.max_tokens,
      stream: Boolean(body.stream),
      provider: body.provider,
    });
  },

  endpoint() {
    return '/v1/chat/completions';
  },

  buildHeaders(provider, key) {
    return {
      authorization: `Bearer ${key.value}`,
      'content-type': 'application/json',
      ...provider.headers,
    };
  },

  buildReq(ir) {
    const payload = {
      model: ir.model,
      messages: ir.messages.map((message) => ({
        ...message,
        content: Array.isArray(message.content)
          ? messageContentToOpenAiContent(message.content)
          : message.content,
      })),
      temperature: ir.temperature,
      max_tokens: ir.maxTokens,
      stream: ir.stream,
    };

    if (ir.stream) {
      payload.stream_options = { include_usage: true };
    }

    return payload;
  },

  async *parse(response, url) {
    if (!response.ok) {
      await readJsonError(response, url);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('text/event-stream')) {
      const data = await parseJsonBody(response);
      yield messageFromOpenAiJson(data);
      return;
    }

    if (!response.body) {
      throw new Error('Upstream did not provide a response body for streaming');
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let model = '';
    let finishReason = 'stop';
    let usage = {};

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        yield* processOpenAiSseEvent(event, (m) => { model = m; }, (f) => { finishReason = f; }, (u) => { usage = u; });
      }
    }

    if (buffer.trim()) {
      yield* processOpenAiSseEvent(buffer, (m) => { model = m; }, (f) => { finishReason = f; }, (u) => { usage = u; });
    }

    yield createMessage({ content: '', model, finishReason, usage });
  },

  buildRes(irMessage) {
    const usage = irMessage.usage ?? {};
    return {
      id: `chatcmpl_${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: irMessage.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: irMessage.content ?? '' },
          finish_reason: irMessage.finishReason ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      },
    };
  },

  async writeStream(reply, irEvents, ir) {
    const messageId = `chatcmpl_${Date.now()}`;
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    const write = (data) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let firstChunk = true;
    for await (const event of irEvents) {
      if (event.type === 'delta') {
        if (firstChunk) {
          write({
            id: messageId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: ir.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          });
          firstChunk = false;
        }
        write({
          id: messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: ir.model,
          choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
        });
      } else if (event.type === 'message') {
        if (firstChunk && event.content) {
          write({
            id: messageId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: ir.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: event.content }, finish_reason: null }],
          });
        }
        write({
          id: messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: ir.model,
          choices: [{ index: 0, delta: {}, finish_reason: event.finishReason ?? 'stop' }],
          usage: event.usage ? {
            prompt_tokens: event.usage.inputTokens ?? 0,
            completion_tokens: event.usage.outputTokens ?? 0,
            total_tokens: (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0),
          } : undefined,
        });
      }
    }

    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  },

  async listModels(provider, key) {
    const url = buildProviderUrl(provider.baseUrl, '/v1/models');
    const data = await requestJson(url, {
      headers: {
        authorization: `Bearer ${key.value}`,
        ...provider.headers,
      },
    });

    return Array.isArray(data?.data) ? uniqueModels(data.data.map((e) => e.id)) : [];
  },
};

// --- helpers ---

async function parseJsonBody(response) {
  const rawText = await response.text();
  return rawText ? JSON.parse(rawText) : {};
}

function messageFromOpenAiJson(data) {
  if (Array.isArray(data?.choices)) {
    const content = data.choices.map((c) => c?.message?.content ?? '').filter(Boolean).join('\n');
    const usage = data.usage ?? {};
    return createMessage({
      content,
      model: data.model,
      finishReason: data.choices[0]?.finish_reason ?? 'stop',
      usage: {
        inputTokens: usage.prompt_tokens ?? usage.input_tokens,
        outputTokens: usage.completion_tokens ?? usage.output_tokens,
      },
    });
  }

  // Legacy response format (e.g. DashScope output_text)
  return createMessage({
    content: data?.output_text ?? '',
    model: data?.model,
    usage: {
      inputTokens: data?.usage?.input_tokens,
      outputTokens: data?.usage?.output_tokens,
    },
  });
}

function* processOpenAiSseEvent(event, setModel, setFinish, setUsage) {
  const lines = event.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') continue;

    const data = JSON.parse(payloadText);
    if (data.model) setModel(data.model);

    const choice = data?.choices?.[0];
    if (choice?.finish_reason) setFinish(choice.finish_reason);

    if (data?.usage) {
      setUsage({
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      });
    }

    const delta = choice?.delta?.content ?? '';
    if (delta) {
      yield createDelta(delta);
    }
  }
}

function messageContentToOpenAiContent(content) {
  const normalized = normalizeMessageContent(content);

  if (!Array.isArray(normalized)) {
    return '';
  }

  return normalized
    .map((part) => {
      if (part?.type === 'text') {
        return { type: 'text', text: part.text ?? '' };
      }

      if (part?.type === 'image' && part?.data) {
        return {
          type: 'image_url',
          image_url: {
            url: `data:${part.mediaType ?? 'image/png'};base64,${part.data}`,
          },
        };
      }

      if (part?.type === 'image_url' && part?.url) {
        return {
          type: 'image_url',
          image_url: { url: part.url },
        };
      }

      return null;
    })
    .filter(Boolean);
}
