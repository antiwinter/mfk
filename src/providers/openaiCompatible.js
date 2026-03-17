import {
  emitEchoPrompt,
  emitEchoResponse,
  finalizeEcho,
  normalizeOpenAiRequest,
  readJsonError,
  requestJson,
  toOpenAiResponse,
  uniqueModels,
} from './shared.js';

export const openAiCompatibleProvider = {
  type: 'openai-compatible',
  async listModels(provider, key) {
    const url = `${provider.baseUrl}/v1/models`;
    const data = await requestJson(url, {
      headers: buildHeaders(provider, key.value),
    });

    return Array.isArray(data?.data)
      ? uniqueModels(data.data.map((entry) => entry.id))
      : [];
  },
  async invoke(provider, key, request, options = {}) {
    const url = `${provider.baseUrl}/v1/chat/completions`;
    emitEchoPrompt(options.echo, request);
    const payload = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
    };

    const data = await requestJson(url, {
      method: 'POST',
      headers: {
        ...buildHeaders(provider, key.value),
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (Array.isArray(data?.choices)) {
      const content = data.choices
        .map((choice) => choice?.message?.content ?? '')
        .filter(Boolean)
        .join('\n');
      emitEchoResponse(options.echo, content);
      finalizeEcho(options.echo);
      return data;
    }

    const normalized = toOpenAiResponse({
      id: data?.id,
      model: request.model,
      content: data?.output_text ?? '',
      usage: {
        promptTokens: data?.usage?.input_tokens,
        completionTokens: data?.usage?.output_tokens,
      },
    });
    emitEchoResponse(options.echo, normalized.choices[0]?.message?.content ?? '');
    finalizeEcho(options.echo);
    return normalized;
  },
  async invokeStream(provider, key, request, handlers = {}) {
    const url = `${provider.baseUrl}/v1/chat/completions`;
    emitEchoPrompt(handlers.echo, request);
    const payload = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: {
        include_usage: true,
      },
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...buildHeaders(provider, key.value),
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      await readJsonError(response, url);
    }

    if (!response.body) {
      throw new Error('Upstream did not provide a response body for streaming');
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const rawText = await response.text();
      const data = rawText ? JSON.parse(rawText) : {};

      if (Array.isArray(data?.choices)) {
        const content = data.choices
          .map((choice) => choice?.message?.content ?? '')
          .filter(Boolean)
          .join('\n');

        if (content) {
          emitEchoResponse(handlers.echo, content);
        }

        finalizeEcho(handlers.echo);
        return data;
      }

      const normalized = toOpenAiResponse({
        model: request.model,
        content: data?.output_text ?? '',
      });
      emitEchoResponse(handlers.echo, normalized.choices[0]?.message?.content ?? '');
      finalizeEcho(handlers.echo);
      return normalized;
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
        const lines = event
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);

        for (const line of lines) {
          if (!line.startsWith('data:')) {
            continue;
          }

          const payloadText = line.slice(5).trim();
          if (!payloadText || payloadText === '[DONE]') {
            continue;
          }

          const data = JSON.parse(payloadText);
          const delta = data?.choices?.[0]?.delta?.content ?? '';

          if (delta) {
            content += delta;
            emitEchoResponse(handlers.echo, delta);
          }
        }
      }
    }

    if (buffer.trim()) {
      const lines = buffer
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        if (!line.startsWith('data:')) {
          continue;
        }

        const payloadText = line.slice(5).trim();
        if (!payloadText || payloadText === '[DONE]') {
          continue;
        }

        const data = JSON.parse(payloadText);
        const delta = data?.choices?.[0]?.delta?.content ?? '';

        if (delta) {
          content += delta;
          emitEchoResponse(handlers.echo, delta);
        }
      }
    }

    const normalized = toOpenAiResponse({
      model: request.model,
      content,
    });
    finalizeEcho(handlers.echo);
    return normalized;
  },
  normalizeRequest: normalizeOpenAiRequest,
};

function buildHeaders(provider, apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    ...provider.headers,
  };
}