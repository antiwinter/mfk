// Static model capability catalog.
//
// Upstream configs (~/.mfk/config.json) only list model *ids*. Downstream
// targets such as omp want richer metadata (context window, modalities, cost).
// This catalog supplies those extras, matched to a config model id by shortest
// edit distance so that near-miss ids (e.g. `gpt-5.6-sol`) still resolve to the
// closest known family entry.
//
// NOTE: contextWindow / maxTokens / cost figures are best-effort and some
// entries describe unreleased or provider-relabelled models — verify against
// the upstream provider docs before relying on the cost/usage numbers.

import { distance } from 'fastest-levenshtein';
import { normalizeModelId } from './models.js';

// Per-million-token costs. cacheRead/cacheWrite omitted where not applicable.
export const MODEL_CATALOG = [
  // --- Anthropic Claude -----------------------------------------------------
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },

  // --- OpenAI GPT -----------------------------------------------------------
  {
    id: 'gpt-5.6',
    name: 'GPT-5.6',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 400000,
    maxTokens: 128000,
    cost: { input: 1.25, output: 10, cacheRead: 0.125 },
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 400000,
    maxTokens: 128000,
    cost: { input: 1.25, output: 10, cacheRead: 0.125 },
  },

  // --- Google Gemini --------------------------------------------------------
  {
    id: 'gemini-3-pro',
    name: 'Gemini 3 Pro',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1000000,
    maxTokens: 65536,
    cost: { input: 1.25, output: 10, cacheRead: 0.31 },
  },

  // --- DeepSeek -------------------------------------------------------------
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    reasoning: true,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 32000,
    cost: { input: 0.27, output: 1.1, cacheRead: 0.07 },
  },

  // --- Zhipu GLM ------------------------------------------------------------
  {
    id: 'glm-5.2',
    name: 'GLM 5.2',
    reasoning: true,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 0.6, output: 2.2 },
  },

  // --- Alibaba Qwen ---------------------------------------------------------
  {
    id: 'qwen3.7-plus',
    name: 'Qwen 3.7 Plus',
    reasoning: true,
    input: ['text'],
    contextWindow: 256000,
    maxTokens: 32000,
    cost: { input: 0.4, output: 1.2 },
  },
];

// Strip provider namespace and a few common vendor suffixes that upstreams bolt
// onto a base id (e.g. `deepseek-v4-pro-anthropic`, `glm-5.2-anthropic`).
const VENDOR_SUFFIX = /-(anthropic|openai|google|messages|responses|completions)$/;

function canonicalId(modelId) {
  return normalizeModelId(modelId).replace(VENDOR_SUFFIX, '').toLowerCase();
}

// Levenshtein distance via fastest-levenshtein.
export function editDistance(a, b) {
  return distance(String(a ?? ''), String(b ?? ''));
}

function sharedPrefixLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

// Accept a fuzzy match only when the edit distance is small relative to the
// requested id length, so genuinely unknown models don't inherit random specs.
function matchThreshold(requestedLen) {
  return Math.max(2, Math.ceil(0.4 * requestedLen));
}

// Find the catalog entry closest to `modelId`. Returns null when the nearest
// entry is beyond the acceptance threshold.
export function lookupModelInfo(modelId) {
  const target = canonicalId(modelId);
  if (!target) return null;

  let best = null;
  let bestDistance = Infinity;
  let bestPrefix = -1;

  for (const entry of MODEL_CATALOG) {
    const candidate = canonicalId(entry.id);
    const distance = editDistance(target, candidate);
    const prefix = sharedPrefixLength(target, candidate);
    if (
      distance < bestDistance
      || (distance === bestDistance && prefix > bestPrefix)
    ) {
      best = entry;
      bestDistance = distance;
      bestPrefix = prefix;
    }
  }

  if (!best || bestDistance > matchThreshold(target.length)) return null;
  return best;
}
