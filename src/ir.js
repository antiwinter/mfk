// Intermediate Representation for LLM requests and responses.
// All engines convert their wire formats to/from these shapes.

export function createIR({ model, messages, temperature, maxTokens, stream, provider }) {
  return {
    model: model ?? '',
    messages: Array.isArray(messages)
      ? messages.map((message) => ({
          ...message,
          content: normalizeMessageContent(message.content),
        }))
      : [],
    temperature,
    maxTokens,
    stream: Boolean(stream),
    provider,
  };
}

export function createDelta(text) {
  return { type: 'delta', text };
}

export function createMessage({ content, model, finishReason, usage }) {
  return {
    type: 'message',
    content: content ?? '',
    model: model ?? '',
    finishReason: finishReason ?? 'stop',
    usage: {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
    },
  };
}

// Collect an async generator of IR events into a single message.
// Accumulates delta text and returns the final message event.
export async function collectEvents(eventStream) {
  let accumulated = '';
  let message = null;

  for await (const event of eventStream) {
    if (event.type === 'delta') {
      accumulated += event.text;
    } else if (event.type === 'message') {
      message = event;
    }
  }

  if (!message) {
    return createMessage({ content: accumulated });
  }

  if (accumulated && !message.content) {
    return { ...message, content: accumulated };
  }

  return message;
}

export function flattenMessageContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' || typeof part?.text === 'string')
      .map((part) => part.text ?? '')
      .join('\n');
  }

  return '';
}

export function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(normalizeMessagePart)
    .filter(Boolean);
}

function normalizeMessagePart(part) {
  if (!part) {
    return null;
  }

  if (typeof part === 'string') {
    return { type: 'text', text: part };
  }

  if (part.type === 'text' || typeof part.text === 'string') {
    return { type: 'text', text: part.text ?? '' };
  }

  if (part.type === 'image' && part.data) {
    return {
      type: 'image',
      mediaType: part.mediaType ?? 'image/png',
      data: part.data,
    };
  }

  if (part.type === 'image' && part.source?.type === 'base64' && part.source?.data) {
    return {
      type: 'image',
      mediaType: part.source.media_type ?? part.source.mediaType ?? 'image/png',
      data: part.source.data,
    };
  }

  if (part.type === 'image_url' && part.image_url?.url) {
    return normalizeImageUrl(part.image_url.url);
  }

  if (part.inlineData?.data) {
    return {
      type: 'image',
      mediaType: part.inlineData.mimeType ?? part.inlineData.mediaType ?? 'image/png',
      data: part.inlineData.data,
    };
  }

  return null;
}

function normalizeImageUrl(url) {
  const value = String(url ?? '');
  const match = value.match(/^data:([^;,]+);base64,(.+)$/);

  if (match) {
    return {
      type: 'image',
      mediaType: match[1],
      data: match[2],
    };
  }

  return {
    type: 'image_url',
    url: value,
  };
}

export function collectSystemPrompt(messages) {
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => flattenMessageContent(message.content))
    .filter(Boolean)
    .join('\n\n');
}
