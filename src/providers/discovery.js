import { getProviderAdapter } from './index.js';
import { createEchoOptions, uniqueModels } from './shared.js';

const DETECTION_PRIORITY = ['anthropic', 'openai-compatible', 'google'];

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

export async function detectProviderConfiguration({ baseProvider, key }) {
  const attempts = [];
  const reporter = baseProvider.reporter;

  for (const type of DETECTION_PRIORITY) {
    reporter?.onStyleStart?.(type);
    const provider = {
      ...baseProvider,
      type,
      keys: [key],
    };

    try {
      const discovery = await discoverProviderModels(provider);
      reporter?.onModelListSuccess?.({
        type,
        latencyMs: discovery.latencyMs,
        modelCount: discovery.models.length,
      });
      const probeCandidates = selectProbeModels(discovery.models);

      if (probeCandidates.length === 0) {
        attempts.push({
          type,
          status: 'failed',
          reason: 'No concrete model available for probe',
        });
        reporter?.onStyleFailure?.({
          type,
          reason: 'No concrete model available for probe',
        });
        continue;
      }

      const probeFailures = [];
      for (const probeModel of probeCandidates) {
        try {
          reporter?.onProbeStart?.({
            type,
            model: probeModel,
          });
          const probe = await probeProviderModel(provider, discovery.key, probeModel);
          reporter?.onStyleSuccess?.({
            type,
            probeModel,
            listLatencyMs: discovery.latencyMs,
            probeLatencyMs: probe.latencyMs,
          });
          return {
            provider: {
              ...provider,
              models: discovery.models,
            },
            key: discovery.key,
            models: discovery.models,
            type,
            listLatencyMs: discovery.latencyMs,
            probeLatencyMs: probe.latencyMs,
            probeModel,
            prompt: probe.prompt,
            attempts,
          };
        } catch (error) {
          reporter?.onProbeFailure?.({
            type,
            model: probeModel,
            reason: error.message,
          });
          probeFailures.push(`${probeModel}: ${error.message}`);
        }
      }

      const reason = probeFailures.join(' | ');
      attempts.push({
        type,
        status: 'failed',
        reason,
      });
      reporter?.onStyleFailure?.({
        type,
        reason,
      });
    } catch (error) {
      attempts.push({
        type,
        status: 'failed',
        reason: error.message,
      });
      reporter?.onStyleFailure?.({
        type,
        reason: error.message,
      });
    }
  }

  const summary = attempts.map((attempt) => `${attempt.type}: ${attempt.reason}`).join('; ');
  throw new Error(`Unable to detect provider API style. ${summary}`);
}

function compareText(left, right) {
  return left.localeCompare(right);
}

function selectProbeModels(models) {
  const concreteModels = models.filter((model) => !model.includes('*'));

  return concreteModels
    .slice()
    .sort((left, right) => compareProbeRank(left, right) || compareText(left, right))
    .slice(0, 5);
}

function compareProbeRank(left, right) {
  return getProbeRank(left) - getProbeRank(right);
}

function getProbeRank(model) {
  const normalized = model.toLowerCase();

  if (normalized.includes('sonnet-4-6')) {
    return 0;
  }

  if (normalized.includes('sonnet-4-5')) {
    return 1;
  }

  if (normalized.includes('sonnet-4')) {
    return 2;
  }

  if (normalized.includes('haiku-4-5')) {
    return 3;
  }

  if (normalized.includes('haiku')) {
    return 4;
  }

  if (normalized.includes('opus-4-6')) {
    return 5;
  }

  if (normalized.includes('opus')) {
    return 6;
  }

  return 50;
}