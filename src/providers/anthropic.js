import {
  collectSystemPrompt,
  emitEchoPrompt,
  emitEchoResponse,
  finalizeEcho,
  flattenMessageContent,
  normalizeOpenAiRequest,
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
  normalizeRequest: normalizeOpenAiRequest,
};

function buildHeaders(provider, apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': provider.headers?.['anthropic-version'] ?? ANTHROPIC_VERSION,
    ...provider.headers,
  };
}