// Intermediate Representation for LLM requests and responses.
// All engines convert their wire formats to/from these shapes.

export function createIR({ model, messages, temperature, maxTokens, stream, provider }) {
  return {
    model: model ?? '',
    messages: Array.isArray(messages) ? messages : [],
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

export function collectSystemPrompt(messages) {
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => flattenMessageContent(message.content))
    .filter(Boolean)
    .join('\n\n');
}
