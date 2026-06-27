import {
  createIR,
  createDelta,
  createMessage,
  flattenMessageContent,
} from '../ir.js';
import { buildProviderUrl, readJsonError, requestJson, uniqueModels } from '../lib/http.js';

// OpenAI Responses API engine. Mirrors src/engines/openai.js (chat-completions style)
// but speaks the newer /v1/responses wire format: `input` instead of `messages`,
// `instructions` instead of a top-level system message, `max_output_tokens`, and
// `tools` defined per the Responses tool spec.
//
// The engine shares provider.type === 'openai' with the chat-completions engine;
// the inbound style (which engine picked up the request) determines the outbound
// style. See src/server/app.js (passthrough trigger uses canBypassTo) and
// src/lib/responsesConvert.js (cross-style IR conversion).

export const openaiResponsesEngine = {
  type: 'openai',
  apiStyle: 'responses',

  canBypassTo(provider) {
    return provider?.type === 'openai';
  },

  parseReq(body) {
    const input = body.input;
    const inputItems = Array.isArray(input) ? input.map(cloneInputItem) : null;
    const messages = Array.isArray(input) ? null : stringInputToMessages(input);

    return createIR({
      model: body.model,
      messages: messages ?? [],
      inputItems,
      instructions: typeof body.instructions === 'string' ? body.instructions : null,
      tools: Array.isArray(body.tools) ? body.tools : null,
      previousResponseId: typeof body.previous_response_id === 'string'
        ? body.previous_response_id
        : null,
      temperature: body.temperature,
      maxTokens: body.max_output_tokens ?? body.max_tokens,
      stream: Boolean(body.stream),
      provider: body.provider,
    });
  },

  endpoint() {
    return '/v1/responses';
  },

  buildHeaders(provider, key) {
    return {
      authorization: `Bearer ${key.value}`,
      'content-type': 'application/json',
      ...provider.headers,
    };
  },

  buildReq(ir) {
    const payload = {
      model: ir.model,
      input: buildWireInput(ir),
      temperature: ir.temperature,
      max_output_tokens: ir.maxTokens,
      stream: ir.stream,
    };

    if (ir.instructions) {
      payload.instructions = ir.instructions;
    }

    if (ir.tools && ir.tools.length > 0) {
      payload.tools = ir.tools;
    }

    if (ir.previousResponseId) {
      payload.previous_response_id = ir.previousResponseId;
    }

    return payload;
  },

  async *parse(response, url) {
    if (!response.ok) {
      await readJsonError(response, url);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('text/event-stream')) {
      const data = await parseJsonBody(response);
      yield messageFromResponsesJson(data);
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
        yield* processResponsesSseEvent(event, (m) => { model = m; }, (f) => { finishReason = f; }, (u) => { usage = u; });
      }
    }

    if (buffer.trim()) {
      yield* processResponsesSseEvent(buffer, (m) => { model = m; }, (f) => { finishReason = f; }, (u) => { usage = u; });
    }

    yield createMessage({ content: '', model, finishReason, usage });
  },

  buildRes(irMessage) {
    const usage = irMessage.usage ?? {};
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;

    return {
      id: `resp_${Date.now()}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: irMessage.model,
      status: irMessage.finishReason === 'incomplete' ? 'incomplete' : 'completed',
      parallel_tool_calls: true,
      tools: [],
      output: [
        {
          type: 'message',
          id: `msg_${Date.now()}`,
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: irMessage.content ?? '',
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  },

  async writeStream(reply, irEvents, ir) {
    const responseId = `resp_${Date.now()}`;
    const itemId = `msg_${Date.now()}`;
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    const writeEvent = (event, data) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      writeEvent('response.created', {
        type: 'response.created',
        response: {
          id: responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: ir.model,
          status: 'in_progress',
          parallel_tool_calls: true,
          tools: [],
          output: [],
        },
      });
      writeEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          id: itemId,
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      });
      writeEvent('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    };

    let outputText = '';
    for await (const event of irEvents) {
      if (event.type === 'delta') {
        start();
        outputText += event.text;
        writeEvent('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: event.text,
        });
      } else if (event.type === 'message') {
        if (event.content) {
          start();
          outputText += event.content;
          writeEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta: event.content,
          });
        }
      }
    }

    start();
    writeEvent('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: outputText,
    });
    writeEvent('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: outputText, annotations: [] },
    });
    writeEvent('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: itemId,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: outputText, annotations: [] }],
      },
    });
    writeEvent('response.completed', {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: ir.model,
        status: 'completed',
        parallel_tool_calls: true,
        tools: [],
        output: [
          {
            type: 'message',
            id: itemId,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: outputText, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 0,
          output_tokens: outputText.length,
          total_tokens: outputText.length,
        },
      },
    });
    reply.raw.end();
  },

  async listModels(provider, key) {
    const url = buildProviderUrl(provider.baseUrl, '/v1/models');
    const data = await requestJson(url, {
      headers: {
        authorization: `Bearer ${key.value}`,
        ...provider.headers,
      },
    });

    return Array.isArray(data?.data) ? uniqueModels(data.data.map((e) => e.id)) : [];
  },
};

// --- helpers ---

async function parseJsonBody(response) {
  const rawText = await response.text();
  return rawText ? JSON.parse(rawText) : {};
}

function cloneInputItem(item) {
  return item == null ? item : structuredClone(item);
}

function stringInputToMessages(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return [];
  }
  return [{ role: 'user', content: input }];
}

function buildWireInput(ir) {
  if (Array.isArray(ir.inputItems) && ir.inputItems.length > 0) {
    return ir.inputItems;
  }

  if (Array.isArray(ir.messages) && ir.messages.length > 0) {
    return ir.messages
      .filter((message) => message?.role !== 'system')
      .map((message) => ({
        type: 'message',
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: flattenMessageContent(message.content),
      }));
  }

  return '';
}

function messageFromResponsesJson(data) {
  const output = Array.isArray(data?.output) ? data.output : [];
  const text = output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('');

  const usage = data?.usage ?? {};
  return createMessage({
    content: text,
    model: data?.model,
    finishReason: data?.status === 'incomplete' ? 'incomplete' : 'stop',
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    },
  });
}

function* processResponsesSseEvent(event, setModel, setFinish, setUsage) {
  const lines = event.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') continue;

    let data;
    try {
      data = JSON.parse(payloadText);
    } catch {
      continue;
    }

    if (data.response?.model) {
      setModel(data.response.model);
    } else if (data.model) {
      setModel(data.model);
    }

    if (data.type === 'response.completed' && data.response) {
      const status = data.response.status;
      if (status === 'incomplete') setFinish('incomplete');
      if (data.response.usage) {
        setUsage({
          inputTokens: data.response.usage.input_tokens,
          outputTokens: data.response.usage.output_tokens,
        });
      }
      continue;
    }

    if (data.type === 'response.output_text.delta') {
      const delta = data.delta ?? '';
      if (delta) yield createDelta(delta);
      continue;
    }

    if (data.type === 'response.incomplete' && data.response?.status === 'incomplete') {
      setFinish('incomplete');
    }
  }
}
