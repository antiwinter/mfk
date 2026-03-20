import {
  createIR,
  createDelta,
  createMessage,
  flattenMessageContent,
  collectSystemPrompt,
  normalizeMessageContent,
} from '../ir.js';
import { buildProviderUrl, readJsonError, requestJson, uniqueModels } from '../lib/http.js';

export const googleEngine = {
  type: 'google',

  parseReq(body, params = {}) {
    // Google requests come in as { contents, generationConfig, systemInstruction }
    // The model is typically in the URL path, passed via params.model
    const messages = [];

    if (body.systemInstruction) {
      const text = Array.isArray(body.systemInstruction.parts)
        ? body.systemInstruction.parts.map((p) => p.text ?? '').join('\n')
        : '';
      if (text) messages.push({ role: 'system', content: text });
    }

    if (Array.isArray(body.contents)) {
      for (const entry of body.contents) {
        const role = entry.role === 'model' ? 'assistant' : 'user';
        const content = Array.isArray(entry.parts)
          ? entry.parts
          : '';
        messages.push({ role, content });
      }
    }

    const gen = body.generationConfig ?? {};
    return createIR({
      model: params.model ?? body.model ?? '',
      messages,
      temperature: gen.temperature,
      maxTokens: gen.maxOutputTokens,
      stream: Boolean(params.stream),
      provider: body.provider,
    });
  },

  endpoint(ir, key) {
    const action = ir.stream
      ? `streamGenerateContent?alt=sse&key=${encodeURIComponent(key.value)}`
      : `generateContent?key=${encodeURIComponent(key.value)}`;
    return `/v1beta/models/${encodeURIComponent(ir.model)}:${action}`;
  },

  buildHeaders(provider) {
    return {
      'content-type': 'application/json',
      ...provider.headers,
    };
  },

  buildReq(ir) {
    const systemPrompt = collectSystemPrompt(ir.messages);
    const contents = ir.messages
      .filter((msg) => msg.role !== 'system')
      .map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: Array.isArray(msg.content)
          ? messageContentToGoogleParts(msg.content)
          : [{ text: flattenMessageContent(msg.content) }],
      }));

    return {
      contents,
      generationConfig: {
        temperature: ir.temperature,
        maxOutputTokens: ir.maxTokens,
      },
      systemInstruction: systemPrompt
        ? { role: 'system', parts: [{ text: systemPrompt }] }
        : undefined,
    };
  },

  async *parse(response, url) {
    if (!response.ok) {
      await readJsonError(response, url);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('text/event-stream')) {
      const data = await response.json();
      yield messageFromGoogleJson(data);
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
        yield* processGoogleSseEvent(
          event,
          (nextModel) => { model = nextModel; },
          (nextReason) => { finishReason = nextReason; },
          (nextUsage) => { usage = nextUsage; },
        );
      }
    }

    if (buffer.trim()) {
      yield* processGoogleSseEvent(
        buffer,
        (nextModel) => { model = nextModel; },
        (nextReason) => { finishReason = nextReason; },
        (nextUsage) => { usage = nextUsage; },
      );
    }

    yield createMessage({ content: '', model, finishReason, usage });
  },

  buildRes(irMessage) {
    return {
      candidates: [
        {
          content: {
            parts: [{ text: irMessage.content ?? '' }],
            role: 'model',
          },
          finishReason: irMessage.finishReason === 'stop' ? 'STOP' : (irMessage.finishReason ?? 'STOP'),
        },
      ],
      usageMetadata: {
        promptTokenCount: irMessage.usage?.inputTokens ?? 0,
        candidatesTokenCount: irMessage.usage?.outputTokens ?? 0,
        totalTokenCount: (irMessage.usage?.inputTokens ?? 0) + (irMessage.usage?.outputTokens ?? 0),
      },
    };
  },

  async writeStream(reply, irEvents, ir) {
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    for await (const event of irEvents) {
      if (event.type === 'delta') {
        const chunk = {
          candidates: [{
            content: { parts: [{ text: event.text }], role: 'model' },
          }],
        };
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      } else if (event.type === 'message' && event.content) {
        const chunk = {
          candidates: [{
            content: { parts: [{ text: event.content }], role: 'model' },
            finishReason: 'STOP',
          }],
          usageMetadata: {
            promptTokenCount: event.usage?.inputTokens ?? 0,
            candidatesTokenCount: event.usage?.outputTokens ?? 0,
            totalTokenCount: (event.usage?.inputTokens ?? 0) + (event.usage?.outputTokens ?? 0),
          },
        };
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }

    reply.raw.end();
  },

  async listModels(provider, key) {
    const url = buildProviderUrl(provider.baseUrl, `/v1beta/models?key=${encodeURIComponent(key.value)}`);
    const data = await requestJson(url, {
      headers: { ...provider.headers },
    });

    return Array.isArray(data?.models)
      ? uniqueModels(data.models.map((e) => e.name?.replace(/^models\//, '')))
      : [];
  },
};

// --- helpers ---

function extractGoogleText(data) {
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  return Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts.map((p) => p.text ?? '').join('\n')
    : '';
}

function messageFromGoogleJson(data) {
  return createMessage({
    content: extractGoogleText(data),
    finishReason: data?.candidates?.[0]?.finishReason ?? 'stop',
    usage: {
      inputTokens: data?.usageMetadata?.promptTokenCount,
      outputTokens: data?.usageMetadata?.candidatesTokenCount,
    },
  });
}

function* processGoogleSseEvent(event, setModel, setFinishReason, setUsage) {
  const lines = event.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') continue;

    const data = JSON.parse(payloadText);
    const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
    if (candidate?.modelVersion) {
      setModel(candidate.modelVersion);
    }
    if (candidate?.finishReason) {
      setFinishReason(candidate.finishReason);
    }
    if (data?.usageMetadata) {
      setUsage({
        inputTokens: data.usageMetadata.promptTokenCount,
        outputTokens: data.usageMetadata.candidatesTokenCount,
      });
    }

    const text = extractGoogleText(data);
    if (text) {
      yield createDelta(text);
    }
  }
}

function messageContentToGoogleParts(content) {
  const normalized = normalizeMessageContent(content);

  if (!Array.isArray(normalized)) {
    return [];
  }

  return normalized
    .map((part) => {
      if (part?.type === 'text') {
        return { text: part.text ?? '' };
      }

      if (part?.type === 'image' && part?.data) {
        return {
          inlineData: {
            mimeType: part.mediaType ?? 'image/png',
            data: part.data,
          },
        };
      }

      return null;
    })
    .filter(Boolean);
}
