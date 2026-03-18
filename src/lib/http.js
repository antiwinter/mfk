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

export function buildProviderUrl(baseUrl, endpointPath) {
  const base = new URL(baseUrl);
  const endpoint = new URL(endpointPath, 'http://mfk.local');
  const baseSegments = splitPathSegments(base.pathname);
  const endpointSegments = splitPathSegments(endpoint.pathname);
  const overlap = findSegmentOverlap(baseSegments, endpointSegments);
  const joinedSegments = [...baseSegments, ...endpointSegments.slice(overlap)];

  base.pathname = joinedSegments.length === 0 ? '/' : `/${joinedSegments.join('/')}`;
  base.search = endpoint.search;
  base.hash = endpoint.hash;

  return base.toString().replace(/\/$/, base.pathname === '/' ? '/' : '');
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



function extractEchoPrompt(request) {
  const userMessage = [...(request?.messages ?? [])]
    .reverse()
    .find((message) => message?.role === 'user');

  const content = userMessage?.content ?? '';
  const text = typeof content === 'string' ? content : '';
  return text || '(empty prompt)';
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

function splitPathSegments(pathname) {
  return String(pathname ?? '')
    .split('/')
    .filter(Boolean);
}

function findSegmentOverlap(leftSegments, rightSegments) {
  const maxOverlap = Math.min(leftSegments.length, rightSegments.length);

  for (let size = maxOverlap; size > 0; size -= 1) {
    const leftSuffix = leftSegments.slice(-size);
    const rightPrefix = rightSegments.slice(0, size);

    if (leftSuffix.every((segment, index) => segment === rightPrefix[index])) {
      return size;
    }
  }

  return 0;
}