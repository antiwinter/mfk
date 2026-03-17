import { normalizeOpenAiRequest, requestJson, toOpenAiResponse } from './shared.js';

export const openAiCompatibleProvider = {
  type: 'openai-compatible',
  async listModels(provider, key) {
    const url = `${provider.baseUrl}/v1/models`;
    const data = await requestJson(url, {
      headers: buildHeaders(provider, key.value),
    });

    return Array.isArray(data?.data) ? data.data.map((entry) => entry.id).filter(Boolean) : [];
  },
  async invoke(provider, key, request) {
    const url = `${provider.baseUrl}/v1/chat/completions`;
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
      return data;
    }

    return toOpenAiResponse({
      id: data?.id,
      model: request.model,
      content: data?.output_text ?? '',
      usage: {
        promptTokens: data?.usage?.input_tokens,
        completionTokens: data?.usage?.output_tokens,
      },
    });
  },
  normalizeRequest: normalizeOpenAiRequest,
};

function buildHeaders(provider, apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    ...provider.headers,
  };
}