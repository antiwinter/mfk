import { anthropicProvider } from './anthropic.js';
import { googleProvider } from './google.js';
import { openAiCompatibleProvider } from './openaiCompatible.js';

const PROVIDERS = new Map([
  [openAiCompatibleProvider.type, openAiCompatibleProvider],
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