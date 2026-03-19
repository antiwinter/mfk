import chalk from 'chalk';
import { millify } from 'millify';

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

export function createDumpOptions(overrides = {}) {
  return {
    enabled: Boolean(overrides.enabled),
    write: overrides.write ?? ((text) => process.stdout.write(text)),
    columns: overrides.columns ?? process.stdout.columns ?? 160,
    promptText: '',
    promptChars: 0,
    responseText: '',
    finished: false,
  };
}

export function createProbeEchoOptions(overrides = {}) {
  return {
    enabled: Boolean(overrides.enabled),
    write: overrides.write ?? ((text) => process.stdout.write(text)),
    columns: overrides.columns ?? process.stdout.columns ?? 160,
    headerWritten: false,
    finished: false,
    responseWritten: false,
    pendingWhitespace: false,
  };
}

export function captureDumpPrompt(dump, request) {
  if (!dump?.enabled || dump.promptChars > 0) {
    return;
  }

  const prompt = extractEchoPrompt(request);
  dump.promptText = prompt;
  dump.promptChars = prompt.length;
}

export function captureDumpResponse(dump, text) {
  if (!dump?.enabled || !text) {
    return;
  }

  dump.responseText += text;
}

export function emitProbeRequestLine(probeEcho, payload) {
  if (!probeEcho?.enabled || probeEcho.headerWritten) {
    return;
  }

  const columns = probeEcho.columns ?? process.stdout.columns ?? 160;
  const promptWidth = Math.max(16, columns - 100);
  const promptText = truncateOneLine(payload.promptText || '(empty prompt)', promptWidth);
  const requestedModel = payload.requestedModel || '-';
  const selectedModel = payload.selectedModel || requestedModel;
  const maskedKey = maskUpstreamKey(payload.selectedKeyValue);
  const promptChars = formatCompactCount(payload.promptChars ?? 0);

  probeEcho.write(chalk.blue(`-> ${requestedModel} (${maskedKey}/${selectedModel}) ${promptText} [${promptChars}]\n`));
  probeEcho.write(chalk.gray('<< '));
  probeEcho.headerWritten = true;
}

export function emitProbeResponse(probeEcho, text) {
  if (!probeEcho?.enabled || !text) {
    return;
  }

  const rawText = String(text ?? '');
  const hasLeadingWhitespace = /^\s/.test(rawText);
  const hasTrailingWhitespace = /\s$/.test(rawText);
  const normalizedText = normalizeOneLine(rawText);

  if (!normalizedText) {
    probeEcho.pendingWhitespace ||= hasLeadingWhitespace || hasTrailingWhitespace;
    return;
  }

  if ((probeEcho.pendingWhitespace || hasLeadingWhitespace) && probeEcho.responseWritten) {
    probeEcho.write(chalk.gray(' '));
  }

  probeEcho.write(chalk.gray(normalizedText));
  probeEcho.responseWritten = true;
  probeEcho.pendingWhitespace = hasTrailingWhitespace;
}

export function emitProbeError(probeEcho, errorType, message) {
  if (!probeEcho?.enabled || probeEcho.finished) {
    return;
  }

  if (!probeEcho.headerWritten) {
    probeEcho.write(chalk.gray('<< '));
    probeEcho.headerWritten = true;
  }

  probeEcho.write(chalk.red(errorType || 'error'));
  if (message) {
    probeEcho.write(` ${chalk.gray(truncateOneLine(message, Math.max(16, (probeEcho.columns ?? process.stdout.columns ?? 160) - 100)))}`);
  }
  probeEcho.responseWritten = true;
}

export function finalizeProbeEcho(probeEcho) {
  if (!probeEcho?.enabled || probeEcho.finished) {
    return;
  }

  if (!probeEcho.responseWritten) {
    probeEcho.write(chalk.gray('(empty response)'));
  }

  probeEcho.write('\n');
  probeEcho.finished = true;
}

export function emitDumpLine(dump, payload) {
  if (!dump?.enabled || dump.finished) {
    return;
  }

  dump.write(`${formatDumpLine({
    ...payload,
    promptText: payload.promptText ?? dump.promptText,
    promptChars: payload.promptChars ?? dump.promptChars,
    responseText: payload.responseText ?? dump.responseText,
  }, dump.columns)}\n`);
  dump.finished = true;
}

export function uniqueModels(models) {
  return [...new Set((models ?? []).filter(Boolean))];
}

export function formatDumpLine(payload, columns = process.stdout.columns ?? 160) {
  const promptWidth = Math.max(16, columns - 100);
  const responseWidth = Math.max(16, columns - 100);
  const promptText = truncateOneLine(payload.promptText || '(empty prompt)', promptWidth);
  const responseText = truncateOneLine(payload.responseText || '(empty response)', responseWidth);
  const requestedModel = payload.requestedModel || '-';
  const selectedModel = payload.selectedModel || payload.requestedModel || '-';
  const promptChars = formatCompactCount(payload.promptChars ?? 0);
  const maskedKey = maskUpstreamKey(payload.selectedKeyValue);
  const requestPart = chalk.blue(`-> ${promptChars} ${requestedModel} (${maskedKey}/${selectedModel}) ${promptText}`);
  const tokenSuffix = formatTokenSuffix(payload.inputTokens, payload.outputTokens);

  if (payload.errorType || payload.status === 'upstream_error' || payload.status === 'auth_error' || payload.status === 'no_candidate') {
    const errorState = payload.errorType || payload.status || 'error';
    const errorMessage = truncateOneLine(payload.errorMessage || responseText, responseWidth);
    const failurePart = `${chalk.gray('<< ')}${chalk.red(errorState)}${errorMessage ? ` ${chalk.gray(errorMessage)}` : ''}`;
    return [requestPart, failurePart, tokenSuffix].filter(Boolean).join(' ');
  }

  const successPart = `${chalk.gray('<< ')}${chalk.gray(responseText)}`;
  return [requestPart, successPart, tokenSuffix].filter(Boolean).join(' ');
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
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .map((part) => part?.text ?? '')
        .filter(Boolean)
        .join(' ')
      : '';
  return text || '(empty prompt)';
}

function formatCompactCount(value) {
  return millify(Number(value ?? 0), {
    precision: 1,
    lowercase: true,
  }).toLowerCase();
}

function formatTokenSuffix(inputTokens, outputTokens) {
  if (inputTokens == null && outputTokens == null) {
    return '';
  }

  return chalk.gray(`[${formatCompactCount(inputTokens ?? 0)} ↑, ${formatCompactCount(outputTokens ?? 0)} ↓]`);
}

function maskUpstreamKey(value) {
  const normalized = String(value ?? '').replace(/^sk-/, '');
  if (!normalized) {
    return '-';
  }

  return `sk-${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function truncateOneLine(value, maxLength) {
  const text = normalizeOneLine(value);

  if (!text) {
    return '';
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 3))}...`;
}

function normalizeOneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
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