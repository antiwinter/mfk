import { getEngine } from './index.js';
import { createIR, collectEvents } from '../ir.js';
import { buildProviderUrl, uniqueModels } from '../lib/http.js';
import { createDump, emitError, emitRequest, emitResponse, finalize } from '../lib/dump.js';

const DETECTION_PRIORITY = ['anthropic', 'openai', 'google'];

const DASHSCOPE_MODELS = ['glm-5', 'kimi-k2.5', 'qwen3-coder-plus', 'qwen3.5-plus', 'MiniMax-M2.5', 'MiniMax/MiniMax-M2.7'];

export async function discoverProviderModels(provider) {
  if (!provider?.key) {
    throw new Error(`Provider ${provider?.name ?? 'unknown'} has no key configured`);
  }

  const engine = getEngine(provider.type);
  const key = provider.key;
  const startedAt = Date.now();

  if (provider.baseUrl?.includes('coding.dashscope.aliyuncs.com')) {
    return {
      provider,
      key,
      models: [...DASHSCOPE_MODELS].sort(compareText),
      latencyMs: Date.now() - startedAt,
    };
  }

  const models = uniqueModels(await engine.listModels(provider, key)).sort(compareText);
  return {
    provider,
    key,
    models,
    latencyMs: Date.now() - startedAt,
  };
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
    stream: true,
    messages: [
      { role: 'system', content: 'Reply briefly and plainly.' },
      { role: 'user', content: probe.prompt },
    ],
  });

  const dump = createDump(handlers.echo);
  emitRequest(dump, {
    requestedModel: model,
    selectedModel: model,
    selectedKeyValue: key.value,
    promptText: probe.prompt,
    promptChars: probe.prompt.length,
  });

  // Try streaming first, fall back to non-stream
  let message;
  try {
    const fetchUrl = buildProviderUrl(provider.baseUrl, engine.endpoint(ir, key));
    const fetchHeaders = engine.buildHeaders(provider, key);
    const fetchBody = engine.buildReq(ir);
    const response = await fetch(fetchUrl, { method: 'POST', headers: fetchHeaders, body: JSON.stringify(fetchBody) });
    const events = engine.parse(response, fetchUrl);
    let accumulated = '';

    for await (const event of events) {
      if (event.type === 'delta') {
        accumulated += event.text;
        emitResponse(dump, event.text);
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
    const fallbackIr = { ...ir, stream: false };
    const fetchUrl = buildProviderUrl(provider.baseUrl, engine.endpoint(fallbackIr, key));
    const fetchHeaders = engine.buildHeaders(provider, key);
    const fetchBody = engine.buildReq(fallbackIr);
    const response = await fetch(fetchUrl, { method: 'POST', headers: fetchHeaders, body: JSON.stringify(fetchBody) });
    message = await collectEvents(engine.parse(response, fetchUrl));
    emitResponse(dump, message.content);
    if (!message?.content && error) {
      emitError(dump, error.errorType ?? 'retryable', error.message);
    }
  }
  finalize(dump, message?.usage);

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
      key,
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

  const sorted = concreteModels.slice().sort(compareText);
  if (sorted.length === 0) return [];
  return [sorted[sorted.length - 1]];
}


