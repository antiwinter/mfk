import { openaiEngine } from './openai.js';
import { anthropicEngine } from './anthropic.js';
import { googleEngine } from './google.js';

const ENGINES = new Map([
  [openaiEngine.type, openaiEngine],
  [anthropicEngine.type, anthropicEngine],
  [googleEngine.type, googleEngine],
]);

export function getEngine(type) {
  const engine = ENGINES.get(type);
  if (!engine) {
    throw new Error(`Unsupported engine type: ${type}`);
  }
  return engine;
}

export function engineForPath(urlPath) {
  if (urlPath.startsWith('/v1/messages')) return anthropicEngine;
  if (urlPath.startsWith('/v1/chat/completions')) return openaiEngine;
  if (urlPath.startsWith('/v1beta/')) return googleEngine;
  return null;
}

export { openaiEngine, anthropicEngine, googleEngine };
