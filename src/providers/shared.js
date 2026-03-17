export async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const rawText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  let body = null;
  if (rawText) {
    if (contentType.includes('application/json')) {
      body = JSON.parse(rawText);
    } else {
      body = { text: rawText };
    }
  }

  if (!response.ok) {
    throw createUpstreamError(url, response.status, body);
  }

  return body;
}

export async function readJsonError(response, url) {
  const rawText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  let body = null;
  if (rawText) {
    if (contentType.includes('application/json')) {
      body = JSON.parse(rawText);
    } else {
      body = { text: rawText };
    }
  }

  throw createUpstreamError(url, response.status, body);
}

export function emitEchoPrompt(echo, request) {
  if (!echo?.enabled || echo.promptWritten) {
    return;
  }

  const prompt = extractEchoPrompt(request);
  echo.write(`-> ${prompt}\n`);
  echo.write('<< ');
  echo.promptWritten = true;
}

export function emitEchoResponse(echo, text) {
  if (!echo?.enabled || !text) {
    return;
  }

  echo.write(text);
  echo.responseWritten = true;
}

export function finalizeEcho(echo) {
  if (!echo?.enabled || echo.finished) {
    return;
  }

  if (!echo.responseWritten) {
    echo.write('(empty response)');
  }

  echo.write('\n');
  echo.finished = true;
}

export function createEchoOptions(overrides = {}) {
  return {
    enabled: Boolean(overrides.enabled),
    write: overrides.write ?? ((text) => process.stdout.write(text)),
    promptWritten: false,
    responseWritten: false,
    finished: false,
  };
}

export function uniqueModels(models) {
  return [...new Set((models ?? []).filter(Boolean))];
}

export function createUpstreamError(url, statusCode, body) {
  const message = extractErrorMessage(body) ?? `Upstream request failed with status ${statusCode}`;
  const type = classifyErrorType(statusCode, body, message);
  const error = new Error(message);
  error.name = 'UpstreamError';
  error.url = url;
  error.statusCode = statusCode;
  error.body = body;
  error.errorType = type;
  error.retryable = type === 'quota' || type === 'retryable';
  return error;
}

export function normalizeOpenAiRequest(body) {
  return {
    model: body.model,
    messages: Array.isArray(body.messages) ? body.messages : [],
    temperature: body.temperature,
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    stream: Boolean(body.stream),
    provider: body.provider,
  };
}

export function toOpenAiResponse(payload) {
  const usage = payload.usage ?? {};

  return {
    id: payload.id ?? `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: payload.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: payload.content ?? '',
        },
        finish_reason: payload.finishReason ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokens ?? 0,
      completion_tokens: usage.completionTokens ?? 0,
      total_tokens: usage.totalTokens ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
    },
  };
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

function extractEchoPrompt(request) {
  const userMessage = [...(request?.messages ?? [])]
    .reverse()
    .find((message) => message?.role === 'user');

  return flattenMessageContent(userMessage?.content ?? '') || '(empty prompt)';
}

function classifyErrorType(statusCode, body, message) {
  const code = body?.error?.code ?? body?.error?.type ?? body?.status ?? '';
  const detail = `${String(code)} ${message}`.toLowerCase();

  if (statusCode === 429 && /quota|insufficient_quota|out of quota|resource exhausted/.test(detail)) {
    return 'quota';
  }

  if (statusCode >= 500 || statusCode === 429 || statusCode === 408) {
    return 'retryable';
  }

  if (statusCode === 401 || statusCode === 403) {
    return 'auth';
  }

  return 'fatal';
}

function extractErrorMessage(body) {
  return body?.error?.message ?? body?.message ?? body?.text ?? null;
}