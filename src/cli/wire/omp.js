import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeModelId } from '../../lib/models.js';
import { lookupModelInfo } from '../../lib/modelInfo.js';

const BLOCK_START = '# >>> mfk wire omp >>>';
const BLOCK_END = '# <<< mfk wire omp <<<';

// Type → omp transport mapping. Fixed per design.
const API_BY_TYPE = new Map([
  ['anthropic', 'anthropic-messages'],
  ['openai', 'openai-responses'],
  ['google', 'google-generative-ai'],
]);

function looksReasoning(modelId) {
  const id = String(modelId ?? '').toLowerCase();
  if (!id) return false;
  return id.includes('opus') || id.includes('thinking');
}

function isWildcard(model) {
  return model === '*' || model.endsWith('/*');
}

function domainPrefix(baseUrl) {
  let host = '';
  try {
    host = new URL(String(baseUrl ?? '')).hostname;
  } catch {
    host = '';
  }
  if (!host) return 'nohost';
  // Registrable domain: keep the last two labels (e.g. api.intchains.in → intchains.in).
  const labels = host.split('.').filter(Boolean);
  const domain = labels.length >= 2 ? labels.slice(-2).join('.') : host;
  return domain.toLowerCase();
}

function buildProviderId(provider, type) {
  const prefix = domainPrefix(provider.baseUrl);
  const orderPad = String(provider.order ?? 0).padStart(2, '0');
  return `${prefix}-${type}-${orderPad}`;
}

function quoteYamlString(value) {
  const str = String(value ?? '');
  if (!str) return '""';
  // Quote any string containing YAML-reserved chars, whitespace, or starting with a special char.
  if (/[:#&*!|>%@`\s]/.test(str) || /^[-?,[\]{}]/.test(str)) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return str;
}

function renderCost(cost) {
  const order = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const parts = order
    .filter((key) => Number.isFinite(cost[key]))
    .map((key) => `${key}: ${cost[key]}`);
  return `{ ${parts.join(', ')} }`;
}

function renderProviderBody(providerId, provider, models) {
  const api = API_BY_TYPE.get(provider.type);
  const lines = [];
  lines.push(`  ${providerId}:`);
  lines.push(`    baseUrl: ${quoteYamlString(provider.baseUrl)}`);
  lines.push(`    apiKey: ${quoteYamlString(provider.apiKey)}`);
  lines.push(`    api: ${api}`);
  lines.push(`    auth: apiKey`);
  lines.push(`    models:`);
  if (models.length === 0) {
    lines.push(`      []`);
  } else {
    for (const model of models) {
      lines.push(`      - id: ${quoteYamlString(model.id)}`);
      if (model.name) lines.push(`        name: ${quoteYamlString(model.name)}`);
      if (model.reasoning) lines.push(`        reasoning: true`);
      if (Array.isArray(model.input) && model.input.length) {
        lines.push(`        input: [${model.input.join(', ')}]`);
      }
      if (Number.isFinite(model.contextWindow)) {
        lines.push(`        contextWindow: ${model.contextWindow}`);
      }
      if (Number.isFinite(model.maxTokens)) {
        lines.push(`        maxTokens: ${model.maxTokens}`);
      }
      if (model.cost) lines.push(`        cost: ${renderCost(model.cost)}`);
    }
  }
  return lines.join('\n');
}

export function generateOmpModelsYml({ config }) {
  const blocks = [];
  for (const provider of config?.providers ?? []) {
    if (!provider?.apiKey || !provider?.baseUrl || !API_BY_TYPE.has(provider.type)) {
      continue;
    }

    const seen = new Set();
    const models = [];
    for (const raw of provider.models ?? []) {
      if (isWildcard(raw)) continue;
      const id = normalizeModelId(raw);
      if (!id || id.includes('/')) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const info = lookupModelInfo(id);
      models.push({
        id,
        name: info?.name ?? id,
        reasoning: info?.reasoning ?? looksReasoning(id),
        input: info?.input,
        contextWindow: info?.contextWindow,
        maxTokens: info?.maxTokens,
        cost: info?.cost,
      });
    }

    const providerId = buildProviderId(provider, provider.type);
    blocks.push(renderProviderBody(providerId, provider, models));
  }

  const body = blocks.join('\n');
  return body;
}

// Wrap as a proper YAML document (top-level `providers:` map).
export function renderOmpModelsYml(body) {
  if (!body.trim()) {
    return 'providers: {}\n';
  }
  return `providers:\n${body}\n`;
}

// --- File IO ----------------------------------------------------------------

const BLOCK_REGEX = new RegExp(
  `${escapeRegex(BLOCK_START)}[\\s\\S]*?${escapeRegex(BLOCK_END)}\\n?`,
);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function home(rel) {
  return path.join(os.homedir(), rel);
}

export function ompModelsPath() {
  return home('.omp/agent/models.yml');
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function backupFile(filePath) {
  const backup = `${filePath}.mfk-backup`;
  if (!fs.existsSync(backup) && fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backup);
  }
  return backup;
}

function hasManagedBlock(text) {
  return text != null && text.includes(BLOCK_START);
}

function setManagedBlock(text, innerContent) {
  const base = removeManagedBlock(text) ?? '';
  const trimmed = base.replace(/\n+$/, '');
  const block = `${BLOCK_START}\n${innerContent}\n${BLOCK_END}`;
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function removeManagedBlock(text) {
  if (text == null) return null;
  const cleaned = text.replace(BLOCK_REGEX, '');
  return cleaned.replace(/\n{3,}/g, '\n\n');
}

export function applyOmpModelsYml({ outPath, body, dryRun = false }) {
  const finalPath = outPath || ompModelsPath();
  if (dryRun) {
    return { path: finalPath, action: 'dry-run', body, backupPath: null };
  }

  backupFile(finalPath);
  const existing = readText(finalPath);
  const text = setManagedBlock(existing, body);
  writeText(finalPath, text);
  return { path: finalPath, action: 'wrote', body, backupPath: `${finalPath}.mfk-backup` };
}

export function clearOmpModelsYml({ outPath } = {}) {
  const finalPath = outPath || ompModelsPath();
  const existing = readText(finalPath);
  if (!hasManagedBlock(existing)) {
    return { path: finalPath, action: 'nothing-to-clear' };
  }
  writeText(finalPath, removeManagedBlock(existing));
  return { path: finalPath, action: 'cleared' };
}

export function detectOmpWired({ outPath } = {}) {
  const finalPath = outPath || ompModelsPath();
  return hasManagedBlock(readText(finalPath));
}
