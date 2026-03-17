import {
  collectSystemPrompt,
  emitEchoPrompt,
  emitEchoResponse,
  finalizeEcho,
  flattenMessageContent,
  normalizeOpenAiRequest,
  readJsonError,
  requestJson,
  toOpenAiResponse,
  uniqueModels,
} from './shared.js';

export const googleProvider = {
  type: 'google',
  async listModels(provider, key) {
    const url = `${provider.baseUrl}/v1beta/models?key=${encodeURIComponent(key.value)}`;
    const data = await requestJson(url, {
      headers: {
        ...provider.headers,
      },
    });

    return Array.isArray(data?.models)
      ? uniqueModels(data.models.map((entry) => entry.name?.replace(/^models\//, '')))
      : [];
  },
  async invoke(provider, key, request, options = {}) {
    const url = `${provider.baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(key.value)}`;
    emitEchoPrompt(options.echo, request);
    const payload = buildPayload(request);

    const data = await requestJson(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...provider.headers,
      },
      body: JSON.stringify(payload),
    });

    const text = extractResponseText(data);

    const normalized = toOpenAiResponse({
      model: request.model,
      content: text,
      finishReason: data?.candidates?.[0]?.finishReason ?? 'stop',
      usage: {
        promptTokens: data?.usageMetadata?.promptTokenCount,
        completionTokens: data?.usageMetadata?.candidatesTokenCount,
        totalTokens: data?.usageMetadata?.totalTokenCount,
      },
    });
    emitEchoResponse(options.echo, text);
    finalizeEcho(options.echo);
    return normalized;
  },
  async invokeStream(provider, key, request, options = {}) {
    const url = `${provider.baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key.value)}`;
    emitEchoPrompt(options.echo, request);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...provider.headers,
      },
      body: JSON.stringify(buildPayload(request)),
    });

    if (!response.ok) {
      await readJsonError(response, url);
    }

    if (!response.body) {
      throw new Error('Upstream did not provide a response body for streaming');
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const data = await response.json();
      const text = extractResponseText(data);
      emitEchoResponse(options.echo, text);
      finalizeEcho(options.echo);
      return toOpenAiResponse({
        model: request.model,
        content: text,
        finishReason: data?.candidates?.[0]?.finishReason ?? 'stop',
        usage: {
          promptTokens: data?.usageMetadata?.promptTokenCount,
          completionTokens: data?.usageMetadata?.candidatesTokenCount,
          totalTokens: data?.usageMetadata?.totalTokenCount,
        },
      });
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let content = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        const delta = processStreamEvent(event, options.echo);
        if (delta) {
          content += delta;
        }
      }
    }

    if (buffer.trim()) {
      const delta = processStreamEvent(buffer, options.echo);
      if (delta) {
        content += delta;
      }
    }

    finalizeEcho(options.echo);
    return toOpenAiResponse({
      model: request.model,
      content,
    });
  },
  normalizeRequest: normalizeOpenAiRequest,
};

function buildPayload(request) {
  const systemPrompt = collectSystemPrompt(request.messages);
  const contents = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [
        {
          text: flattenMessageContent(message.content),
        },
      ],
    }));

  return {
    contents,
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
    },
    systemInstruction: systemPrompt
      ? {
          role: 'system',
          parts: [{ text: systemPrompt }],
        }
      : undefined,
  };
}

function extractResponseText(data) {
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  return Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts.map((part) => part.text ?? '').join('\n')
    : '';
}

function processStreamEvent(event, echo) {
  const lines = event
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  let combined = '';

  for (const line of lines) {
    if (!line.startsWith('data:')) {
      continue;
    }

    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') {
      continue;
    }

    const data = JSON.parse(payloadText);
    const text = extractResponseText(data);
    if (text) {
      combined += text;
      emitEchoResponse(echo, text);
    }
  }

  return combined;
}