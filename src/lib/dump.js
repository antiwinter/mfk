import chalk from 'chalk';
import { millify } from 'millify';

const DUMP_SUFFIX_RESERVE = 20;

export function createDump(overrides = {}) {
  return {
    enabled: Boolean(overrides.enabled),
    write: overrides.write ?? ((text) => process.stdout.write(text)),
    columns: overrides.columns ?? process.stdout.columns ?? 160,
    headerWritten: false,
    responseWritten: false,
    responseLength: 0,
    responseTruncated: false,
    pendingWhitespace: false,
    finished: false,
  };
}

export function emitRequest(dump, payload) {
  if (!dump?.enabled) {
    return;
  }

  if (dump.headerWritten && !dump.finished) {
    return;
  }

  resetDumpState(dump);

  const columns = dump.columns ?? process.stdout.columns ?? 160;
  const requestedModel = payload.requestedModel || '-';
  const selectedModel = payload.selectedModel || requestedModel;
  const maskedKey = maskUpstreamKey(payload.selectedKeyValue);
  const promptChars = formatCompactCount(payload.promptChars ?? extractPromptText(payload.request).length);
  const promptPrefix = `-> ${requestedModel} (${maskedKey}/${selectedModel}) `;
  const promptSuffix = ` [${promptChars}]`;
  const promptWidth = Math.max(16, columns - promptPrefix.length - promptSuffix.length);
  const promptText = truncateOneLine(payload.promptText ?? extractPromptText(payload.request), promptWidth);

  dump.write(chalk.blue(`${promptPrefix}${promptText}${promptSuffix}\n`));
  dump.write(chalk.gray('<< '));
  dump.headerWritten = true;
  dump.finished = false;
}

export function emitResponse(dump, text) {
  if (!dump?.enabled || !text) {
    return;
  }

  if (dump.responseTruncated) {
    return;
  }

  const rawText = String(text ?? '');
  const hasLeadingWhitespace = /^\s/.test(rawText);
  const hasTrailingWhitespace = /\s$/.test(rawText);
  const normalizedText = normalizeOneLine(rawText);

  if (!normalizedText) {
    dump.pendingWhitespace ||= hasLeadingWhitespace || hasTrailingWhitespace;
    return;
  }

  const needsLeadingSpace = (dump.pendingWhitespace || hasLeadingWhitespace) && dump.responseWritten;
  const nextText = needsLeadingSpace ? ` ${normalizedText}` : normalizedText;
  const responseWidth = Math.max(
    16,
    (dump.columns ?? process.stdout.columns ?? 160) - '<< '.length - DUMP_SUFFIX_RESERVE,
  );
  const remainingWidth = responseWidth - dump.responseLength;

  if (remainingWidth <= 0) {
    dump.responseTruncated = true;
    return;
  }

  if (nextText.length <= remainingWidth) {
    dump.write(chalk.gray(nextText));
    dump.responseLength += nextText.length;
    dump.responseWritten = true;
    dump.pendingWhitespace = hasTrailingWhitespace;
    return;
  }

  if (remainingWidth <= 3) {
    dump.write(chalk.gray('.'.repeat(remainingWidth)));
  } else {
    dump.write(chalk.gray(`${nextText.slice(0, remainingWidth - 3)}...`));
  }

  dump.responseLength = responseWidth;
  dump.responseWritten = true;
  dump.responseTruncated = true;
  dump.pendingWhitespace = false;
}

export function emitError(dump, errorType, message) {
  if (!dump?.enabled || dump.finished) {
    return;
  }

  if (!dump.headerWritten) {
    dump.write(chalk.gray('<< '));
    dump.headerWritten = true;
  }

  const normalizedErrorType = errorType || 'error';
  dump.write(chalk.red(normalizedErrorType));
  if (message) {
    const columns = dump.columns ?? process.stdout.columns ?? 160;
    const messageWidth = Math.max(16, columns - `<< ${normalizedErrorType} `.length);
    dump.write(` ${chalk.gray(truncateOneLine(message, messageWidth))}`);
  }
  dump.responseWritten = true;
}

export function finalize(dump, usage) {
  if (!dump?.enabled || dump.finished) {
    return;
  }

  if (!dump.responseWritten) {
    dump.write(chalk.gray('(empty response)'));
  }

  const tokenSuffix = formatTokenSuffix(usage?.inputTokens, usage?.outputTokens);
  if (tokenSuffix) {
    dump.write(` ${tokenSuffix}`);
  }

  dump.write('\n');
  dump.finished = true;
}

export function extractPromptText(request) {
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

  return chalk.gray(`[${formatCompactCount(inputTokens ?? 0)}↑, ${formatCompactCount(outputTokens ?? 0)}↓]`);
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

function resetDumpState(dump) {
  dump.headerWritten = false;
  dump.responseWritten = false;
  dump.responseLength = 0;
  dump.responseTruncated = false;
  dump.pendingWhitespace = false;
  dump.finished = false;
}
