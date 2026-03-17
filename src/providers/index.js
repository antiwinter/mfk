import { anthropicProvider } from './anthropic.js';
import { googleProvider } from './google.js';
import { openaiProvider } from './openai.js';

const PROVIDERS = new Map([
  [openaiProvider.type, openaiProvider],
  [anthropicProvider.type, anthropicProvider],
  [googleProvider.type, googleProvider],
]);

export function getProviderAdapter(type) {
  const provider = PROVIDERS.get(type);
  if (!provider) {
    throw new Error(`Unsupported provider type: ${type}`);
  }

  return provider;
}