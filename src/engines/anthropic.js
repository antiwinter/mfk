import { createIR, createDelta, createMessage, flattenMessageContent, collectSystemPrompt } from '../ir.js';
import { buildProviderUrl, readJsonError, requestJson, uniqueModels } from '../lib/http.js';

const ANTHROPIC_VERSION = '2023-06-01';

export const anthropicEngine = {
  type: 'anthropic',

  parseReq(body) {
    const model = String(body.model ?? '').replace(/^anthropic\//, '');
    const rawMessages = Array.isArray(body.messages)
      ? body.messages.map((msg) => ({
          role: msg.role,
          content: Array.isArray(msg.content)
            ? msg.content.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n')
            : msg.content,
        }))
      : [];

    // Anthropic sends system as a top-level field; convert to a system message in IR
    const messages = body.system
      ? [{ role: 'system', content: body.system }, ...rawMessages]
      : rawMessages;

    return createIR({
      model,
      messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      stream: Boolean(body.stream),
      provider: body.provider,
    });
  },

  endpoint() {
    return '/v1/messages';
  },

  buildHeaders(provider, key) {
    return {
      'x-api-key': key.value,
      'anthropic-version': provider.headers?.['anthropic-version'] ?? ANTHROPIC_VERSION,
      'content-type': 'application/json',
      ...provider.headers,
    };
  },

  buildReq(ir) {
    const systemPrompt = collectSystemPrompt(ir.messages);
    const messages = ir.messages
      .filter((msg) => msg.role !== 'system')
      .map((msg) => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: flattenMessageContent(msg.content),
      }));

    return {
      model: ir.model,
      system: systemPrompt || undefined,
      messages,
      max_tokens: ir.maxTokens ?? 4096,
      temperature: ir.temperature,
      stream: ir.stream,
    };
  },

  async *parse(response, url) {
    if (!response.ok) {
      await readJsonError(response, url);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('text/event-stream')) {
      const data = await response.json();
      yield messageFromAnthropicJson(data);
      return;
    }

    if (!response.body) {
      throw new Error('Upstream did not provide a response body for streaming');
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let model = '';
    let stopReason = 'stop';
    let usage = {};

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        yield* processAnthropicSseEvent(event, (m) => { model = m; }, (s) => { stopReason = s; }, (u) => { usage = u; });
      }
    }

    if (buffer.trim()) {
      yield* processAnthropicSseEvent(buffer, (m) => { model = m; }, (s) => { stopReason = s; }, (u) => { usage = u; });
    }

    yield createMessage({ content: '', model, finishReason: stopReason, usage });
  },

  buildRes(irMessage) {
    const model = String(irMessage.model ?? '').replace(/^anthropic\//, '');
    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: irMessage.content ?? '' }],
      stop_reason: irMessage.finishReason ?? 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: irMessage.usage?.inputTokens ?? 0,
        output_tokens: irMessage.usage?.outputTokens ?? 0,
      },
    };
  },

  async writeStream(reply, irEvents, ir) {
    const messageId = `msg_${Date.now()}`;
    const model = String(ir.model ?? '').replace(/^anthropic\//, '');

    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    const writeEvent = (event, data) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      writeEvent('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      writeEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
    };

    let outputLength = 0;
    for await (const event of irEvents) {
      if (event.type === 'delta') {
        start();
        outputLength += event.text.length;
        writeEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: event.text },
        });
      } else if (event.type === 'message') {
        if (event.content && !started) {
          start();
          outputLength += event.content.length;
          writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: event.content },
          });
        }
      }
    }

    start();
    writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
    writeEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputLength },
    });
    writeEvent('message_stop', { type: 'message_stop' });
    reply.raw.end();
  },

  async listModels(provider, key) {
    const url = buildProviderUrl(provider.baseUrl, '/v1/models');
    const data = await requestJson(url, {
      headers: {
        'x-api-key': key.value,
        'anthropic-version': provider.headers?.['anthropic-version'] ?? ANTHROPIC_VERSION,
        ...provider.headers,
      },
    });

    return Array.isArray(data?.data) ? uniqueModels(data.data.map((e) => e.id)) : [];
  },
};

// --- helpers ---

function messageFromAnthropicJson(data) {
  const text = Array.isArray(data?.content)
    ? data.content.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n')
    : '';

  return createMessage({
    content: text,
    model: data?.model,
    finishReason: data?.stop_reason ?? 'stop',
    usage: {
      inputTokens: data?.usage?.input_tokens,
      outputTokens: data?.usage?.output_tokens,
    },
  });
}

function* processAnthropicSseEvent(event, setModel, setStop, setUsage) {
  const lines = event.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') continue;

    const data = JSON.parse(payloadText);

    if (data.type === 'message_start' && data.message) {
      if (data.message.model) setModel(data.message.model);
      if (data.message.usage) {
        setUsage({
          inputTokens: data.message.usage.input_tokens,
          outputTokens: data.message.usage.output_tokens,
        });
      }
      const text = extractAnthropicResponseText(data.message);
      if (text) yield createDelta(text);
      continue;
    }

    if (data.type === 'message_delta') {
      if (data.delta?.stop_reason) setStop(data.delta.stop_reason);
      if (data.usage) {
        setUsage((prev) => ({
          inputTokens: prev?.inputTokens ?? 0,
          outputTokens: data.usage.output_tokens ?? prev?.outputTokens ?? 0,
        }));
      }
      continue;
    }

    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
      const text = data.delta.text ?? '';
      if (text) yield createDelta(text);
      continue;
    }

    if (data.type === 'content_block_start' && data.content_block?.type === 'text') {
      const text = data.content_block.text ?? '';
      if (text) yield createDelta(text);
      continue;
    }
  }
}

function extractAnthropicResponseText(data) {
  return Array.isArray(data?.content)
    ? data.content.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n')
    : '';
}
