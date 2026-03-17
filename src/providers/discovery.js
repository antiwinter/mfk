import { getProviderAdapter } from './index.js';
import { createEchoOptions, uniqueModels } from './shared.js';

export async function discoverProviderModels(provider) {
  if (!provider?.keys?.length) {
    throw new Error(`Provider ${provider?.name ?? 'unknown'} has no keys configured`);
  }

  const adapter = getProviderAdapter(provider.type);
  let lastError = null;

  for (const key of provider.keys) {
    const startedAt = Date.now();

    try {
      const models = uniqueModels(await adapter.listModels(provider, key)).sort(compareText);
      return {
        provider,
        key,
        models,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Provider test failed: ${lastError?.message ?? 'unknown error'}`);
}

export async function probeProviderModel(provider, key, model, handlers = {}) {
  const adapter = getProviderAdapter(provider.type);
  const startedAt = Date.now();
  const probe = {
    prompt: 'hello, tell me your model name',
  };
  const request = {
    model,
    temperature: 0,
    maxTokens: 64,
    messages: [
      {
        role: 'system',
        content: 'Reply briefly and plainly.',
      },
      {
        role: 'user',
        content: probe.prompt,
      },
    ],
  };
  let response;
  const echo = createEchoOptions(handlers.echo);

  if (adapter.invokeStream) {
    try {
      response = await adapter.invokeStream(provider, key, request, {
        echo,
      });
    } catch (error) {
      if (echo.responseWritten || !adapter.invoke) {
        throw error;
      }

      response = await adapter.invoke(provider, key, request, { echo });
    }
  } else {
    response = await adapter.invoke(provider, key, request, { echo });
  }

  return {
    response,
    latencyMs: Date.now() - startedAt,
    prompt: probe.prompt,
  };
}

function compareText(left, right) {
  return left.localeCompare(right);
}