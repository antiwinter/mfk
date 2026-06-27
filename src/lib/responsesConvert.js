// Cross-style IR converters for the OpenAI Responses API ↔ chat-completions /
// Anthropic Messages wire shapes. The IR stays engine-agnostic; these helpers
// re-shape it when the inbound style differs from the outbound style.

function flattenText(text) {
  if (text == null) return '';
  return typeof text === 'string' ? text : String(text);
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// Convert a Responses-API IR (inputItems + instructions + tools + previousResponseId)
// into a chat-completions-style IR (messages). Used when an inbound /v1/responses
// request routes to an anthropic provider (whose engine.buildReq consumes messages).
export function irFromResponsesToMessages(ir) {
  const messages = [];

  if (ir.instructions) {
    messages.push({ role: 'system', content: flattenText(ir.instructions) });
  }

  const items = Array.isArray(ir.inputItems) ? ir.inputItems : [];
  for (const item of items) {
    pushResponsesItemAsMessage(item, messages);
  }

  // If inputItems was empty but we have legacy messages on the IR, keep them.
  if (items.length === 0 && Array.isArray(ir.messages)) {
    for (const message of ir.messages) {
      messages.push({ role: message.role, content: message.content });
    }
  }

  return {
    ...ir,
    messages,
    inputItems: null,
    instructions: null,
    tools: null,
    previousResponseId: null,
  };
}

// Convert a chat-completions-style IR (messages, possibly with a system-role
// message at index 0) into a Responses-API IR. Used when an inbound /v1/messages
// request routes to an openai provider (whose responses engine.buildReq consumes
// inputItems + instructions).
export function irFromMessagesToResponses(ir) {
  const messages = Array.isArray(ir.messages) ? ir.messages : [];
  const inputItems = [];
  let instructions = null;

  for (const message of messages) {
    if (message?.role === 'system') {
      const text = flattenText(extractMessageText(message.content));
      if (text) {
        instructions = instructions ? `${instructions}\n\n${text}` : text;
      }
      continue;
    }
    pushMessageAsResponsesItem(message, inputItems);
  }

  return {
    ...ir,
    messages: [],
    inputItems,
    instructions,
    tools: null,
    previousResponseId: null,
  };
}

function pushResponsesItemAsMessage(item, messages) {
  if (!isPlainObject(item)) return;

  const type = item.type ?? 'message';

  if (type === 'message') {
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    const content = normalizeResponsesContent(item.content);
    messages.push({ role, content });
    return;
  }

  if (type === 'function_call') {
    const text = item.arguments
      ? `[function_call ${item.name ?? ''}(${flattenText(item.arguments)})]`
      : `[function_call ${item.name ?? ''}]`;
    messages.push({ role: 'assistant', content: text });
    return;
  }

  if (type === 'function_call_output') {
    const text = `[function_call_output ${flattenText(item.output)}]`;
    messages.push({ role: 'user', content: text });
    return;
  }

  // Fall back to text representation so nothing is silently dropped.
  messages.push({ role: 'user', content: JSON.stringify(item) });
}

function pushMessageAsResponsesItem(message, inputItems) {
  if (!isPlainObject(message)) return;

  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const content = normalizeResponsesContent(message.content);

  inputItems.push({
    type: 'message',
    role,
    content,
  });
}

function normalizeResponsesContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => normalizeResponsesContentPart(part))
      .filter((part) => part != null);
    return parts.length === 0 ? '' : parts;
  }

  return '';
}

function normalizeResponsesContentPart(part) {
  if (!isPlainObject(part)) return null;
  const type = part.type;

  if (type === 'input_text' || type === 'text' || type === 'output_text') {
    return { type: 'text', text: flattenText(part.text) };
  }

  if (type === 'input_image' || type === 'image') {
    return normalizeInputImage(part);
  }

  if (type === 'image_url' && part.image_url?.url) {
    return normalizeImageUrl(part.image_url.url);
  }

  return null;
}

function normalizeInputImage(part) {
  if (typeof part.image_url === 'string') {
    return normalizeImageUrl(part.image_url);
  }
  if (part.source?.type === 'base64') {
    const mediaType = part.source.media_type ?? part.source.mediaType ?? 'image/png';
    const data = part.source.data ?? '';
    return normalizeImageUrl(`data:${mediaType};base64,${data}`);
  }
  if (part.data) {
    const mediaType = part.mediaType ?? 'image/png';
    return normalizeImageUrl(`data:${mediaType};base64,${part.data}`);
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

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.text) return flattenText(part.text);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
