import {
  collectSystemPrompt,
  flattenMessageContent,
  normalizeOpenAiRequest,
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
  async invoke(provider, key, request) {
    const url = `${provider.baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(key.value)}`;
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

    const payload = {
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

    const data = await requestJson(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...provider.headers,
      },
      body: JSON.stringify(payload),
    });

    const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
    const text = Array.isArray(candidate?.content?.parts)
      ? candidate.content.parts.map((part) => part.text ?? '').join('\n')
      : '';

    return toOpenAiResponse({
      model: request.model,
      content: text,
      finishReason: candidate?.finishReason ?? 'stop',
      usage: {
        promptTokens: data?.usageMetadata?.promptTokenCount,
        completionTokens: data?.usageMetadata?.candidatesTokenCount,
        totalTokens: data?.usageMetadata?.totalTokenCount,
      },
    });
  },
  normalizeRequest: normalizeOpenAiRequest,
};