import { getEngine } from './index.js';
import { createIR, collectEvents } from '../ir.js';
import { buildProviderUrl, createEchoOptions, emitEchoResponse, finalizeEcho, uniqueModels } from '../lib/http.js';

const DETECTION_PRIORITY = ['anthropic', 'openai', 'google'];

export async function discoverProviderModels(provider) {
  if (!provider?.keys?.length) {
    throw new Error(`Provider ${provider?.name ?? 'unknown'} has no keys configured`);
  }

  const engine = getEngine(provider.type);
  let lastError = null;

  for (const key of provider.keys) {
    const startedAt = Date.now();

    try {
      const models = uniqueModels(await engine.listModels(provider, key)).sort(compareText);
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
  const engine = getEngine(provider.type);
  const startedAt = Date.now();
  const probe = {
    prompt: 'hello, tell me your model name',
  };
  const ir = createIR({
    model,
    temperature: 0,
    maxTokens: 64,
    stream: false,
    messages: [
      { role: 'system', content: 'Reply briefly and plainly.' },
      { role: 'user', content: probe.prompt },
    ],
  });

  const echo = createEchoOptions(handlers.echo);

  // Try streaming first, fall back to non-stream
  let message;
  try {
    const streamIr = { ...ir, stream: true };
    const fetchUrl = buildProviderUrl(provider.baseUrl, engine.endpoint(streamIr, key));
    const fetchHeaders = engine.buildHeaders(provider, key);
    const fetchBody = engine.buildReq(streamIr);
    const response = await fetch(fetchUrl, { method: 'POST', headers: fetchHeaders, body: JSON.stringify(fetchBody) });
    const events = engine.parse(response, url);
    let accumulated = '';

    for await (const event of events) {
      if (event.type === 'delta') {
        accumulated += event.text;
        emitEchoResponse(echo, event.text);
      } else if (event.type === 'message') {
        message = event;
      }
    }

    if (message && accumulated && !message.content) {
      message = { ...message, content: accumulated };
    } else if (!message) {
      message = { type: 'message', content: accumulated };
    }
  } catch (error) {
    // Fall back to non-stream
    const fetchUrl = buildProviderUrl(provider.baseUrl, engine.endpoint(ir, key));
    const fetchHeaders = engine.buildHeaders(provider, key);
    const fetchBody = engine.buildReq(ir);
    const response = await fetch(fetchUrl, { method: 'POST', headers: fetchHeaders, body: JSON.stringify(fetchBody) });
    message = await collectEvents(engine.parse(response, url));
    emitEchoResponse(echo, message.content);
  }

  finalizeEcho(echo);

  return {
    response: message,
    latencyMs: Date.now() - startedAt,
    prompt: probe.prompt,
  };
}

export async function detectProviderConfiguration({ baseProvider, key, knownModel }) {
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
      let discovery = null;

      try {
        discovery = await discoverProviderModels(provider);
        reporter?.onModelListSuccess?.({
          type,
          latencyMs: discovery.latencyMs,
          modelCount: discovery.models.length,
        });
      } catch (error) {
        if (!knownModel) {
          throw error;
        }

        reporter?.onModelListFailure?.({
          type,
          reason: error.message,
        });
      }

      const probeCandidates = selectProbeModels(discovery?.models ?? [], knownModel);

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
            hinted: probeModel === knownModel,
          });
          const probe = await probeProviderModel(provider, discovery?.key ?? key, probeModel);
          const models = uniqueModels(discovery?.models?.length ? discovery.models : [probeModel]).sort(compareText);
          reporter?.onStyleSuccess?.({
            type,
            probeModel,
            listLatencyMs: discovery?.latencyMs ?? null,
            probeLatencyMs: probe.latencyMs,
          });
          return {
            provider: {
              ...provider,
              models,
            },
            key: discovery?.key ?? key,
            models,
            type,
            listLatencyMs: discovery?.latencyMs ?? null,
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

export function selectProbeModels(models, knownModel) {
  const concreteModels = (models ?? []).filter((model) => !model.includes('*'));

  if (knownModel && !concreteModels.includes(knownModel)) {
    concreteModels.push(knownModel);
  }

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

  if (normalized.includes('sonnet-4-6')) return 0;
  if (normalized.includes('sonnet-4-5')) return 1;
  if (normalized.includes('sonnet-4')) return 2;
  if (normalized.includes('haiku-4-5')) return 3;
  if (normalized.includes('haiku')) return 4;
  if (normalized.includes('opus-4-6')) return 5;
  if (normalized.includes('opus')) return 6;

  return 50;
}
