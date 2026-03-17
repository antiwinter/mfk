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

const ANTHROPIC_VERSION = '2023-06-01';

export const anthropicProvider = {
  type: 'anthropic',
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
    const url = `${provider.baseUrl}/v1/messages`;
    emitEchoPrompt(options.echo, request);
    const systemPrompt = collectSystemPrompt(request.messages);
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: flattenMessageContent(message.content),
      }));

    const payload = {
      model: request.model,
      system: systemPrompt || undefined,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature,
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

    const text = Array.isArray(data?.content)
      ? data.content
          .filter((part) => part?.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n')
      : '';

    const normalized = toOpenAiResponse({
      id: data?.id,
      model: data?.model ?? request.model,
      content: text,
      finishReason: data?.stop_reason ?? 'stop',
      usage: {
        promptTokens: data?.usage?.input_tokens,
        completionTokens: data?.usage?.output_tokens,
      },
    });
    emitEchoResponse(options.echo, text);
    finalizeEcho(options.echo);
    return normalized;
  },
  async invokeStream(provider, key, request, options = {}) {
    const url = `${provider.baseUrl}/v1/messages`;
    emitEchoPrompt(options.echo, request);
    const payload = buildPayload(request, true);
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
      const data = await response.json();
      const text = extractResponseText(data);
      if (text) {
        options.onText?.(text);
      }
      emitEchoResponse(options.echo, text);
      finalizeEcho(options.echo);
      return toOpenAiResponse({
        id: data?.id,
        model: data?.model ?? request.model,
        content: text,
        finishReason: data?.stop_reason ?? 'stop',
        usage: {
          promptTokens: data?.usage?.input_tokens,
          completionTokens: data?.usage?.output_tokens,
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
        content += processStreamEvent(event, options);
      }
    }

    if (buffer.trim()) {
      content += processStreamEvent(buffer, options);
    }

    finalizeEcho(options.echo);
    return toOpenAiResponse({
      model: request.model,
      content,
    });
  },
  normalizeRequest: normalizeOpenAiRequest,
};

function buildPayload(request, stream) {
  const systemPrompt = collectSystemPrompt(request.messages);
  const messages = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: flattenMessageContent(message.content),
    }));

  return {
    model: request.model,
    system: systemPrompt || undefined,
    messages,
    max_tokens: request.maxTokens ?? 4096,
    temperature: request.temperature,
    stream,
  };
}

function extractResponseText(data) {
  return Array.isArray(data?.content)
    ? data.content
        .filter((part) => part?.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
    : '';
}

function processStreamEvent(event, options) {
  const lines = event
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  let deltaText = '';

  for (const line of lines) {
    if (!line.startsWith('data:')) {
      continue;
    }

    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') {
      continue;
    }

    const data = JSON.parse(payloadText);
    const text = extractStreamText(data);
    if (text) {
      deltaText += text;
      options.onText?.(text);
      emitEchoResponse(options.echo, text);
    }
  }

  return deltaText;
}

function extractStreamText(data) {
  if (data?.type === 'content_block_delta' && data?.delta?.type === 'text_delta') {
    return data.delta.text ?? '';
  }

  if (data?.type === 'content_block_start' && data?.content_block?.type === 'text') {
    return data.content_block.text ?? '';
  }

  if (data?.type === 'message_start') {
    return extractResponseText(data.message);
  }

  return '';
}

function buildHeaders(provider, apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': provider.headers?.['anthropic-version'] ?? ANTHROPIC_VERSION,
    ...provider.headers,
  };
}