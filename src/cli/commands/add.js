import { buildRuntimeProvider, formatProviderRef, loadConfig, saveConfig } from '../../config/store.js';
import { detectProviderConfiguration } from '../../engines/discovery.js';

export function registerAddCommand(program) {
  program
    .command('add <urlPort> <key>')
    .description('Add a provider by auto-detecting its API style and importing its model list')
    .option('-m, --model <model>', 'Known working model to probe when the provider does not expose /models')
    .action(async (...args) => {
      const [urlPort, apiKey] = args;
      const command = args.at(-1);
      const configPath = program.opts().config;
      const knownModel = command.opts().model?.trim() || null;
      const { config } = await loadConfig(configPath);
      const baseUrl = normalizeBaseUrl(urlPort);
      const existingProvider = config.providers.find((provider) => provider.apiKey === apiKey);

      const probeProvider = existingProvider ?? buildRuntimeProvider({
        apiKey,
        baseUrl,
        type: 'openai',
        models: [],
        order: config.providers.length,
      });

      const tempKey = probeProvider.key;
      const reporter = createDetectionReporter();

      console.log(`provider: ${existingProvider ? formatProviderRef(existingProvider) : config.providers.length + 1}`);
      console.log(`base_url: ${baseUrl}`);
      console.log(`provider_key: ${maskApiKey(apiKey)}`);
      console.log('source: live_api');
      if (knownModel) {
        console.log(`known_model: ${knownModel}`);
      }
      console.log('detecting_api_style: start');

      const detected = await detectProviderConfiguration({
        baseProvider: {
          ...probeProvider,
          reporter,
        },
        key: tempKey,
        knownModel,
      });
      const models = detected.models;

      if (existingProvider) {
        existingProvider.baseUrl = baseUrl;
        existingProvider.type = detected.type;
        existingProvider.models = models;
      } else {
        probeProvider.type = detected.type;
        probeProvider.models = models;
        config.providers.push(probeProvider);
      }

      await saveConfig(configPath, config);
      console.log(`type: ${detected.type}`);
      console.log(`model_list_latency_ms: ${detected.listLatencyMs ?? 'unavailable'}`);
      console.log(`probe_model: ${detected.probeModel}`);
      console.log(`probe_prompt: ${detected.prompt}`);
      console.log(`probe_latency_ms: ${detected.probeLatencyMs}`);
      console.log(`models: ${models.join(', ') || '(none reported)'}`);
    });
}

function normalizeBaseUrl(value) {
  return /^https?:\/\//.test(value) ? value.replace(/\/$/, '') : `http://${value.replace(/\/$/, '')}`;
}

function createDetectionReporter() {
  return {
    onStyleStart(type) {
      console.log(`trying_style: ${type}`);
    },
    onModelListSuccess(event) {
      console.log(`style_model_list: ${event.type} ok (${event.modelCount} models, ${event.latencyMs} ms)`);
    },
    onModelListFailure(event) {
      console.log(`style_model_list_fail: ${event.type} (${summarizeReason(event.reason)})`);
    },
    onProbeStart(event) {
      console.log(`style_probe: ${event.type} -> ${event.model}${event.hinted ? ' (hint)' : ''}`);
    },
    onProbeFailure(event) {
      console.log(`style_probe_fail: ${event.type} -> ${event.model} (${summarizeReason(event.reason)})`);
    },
    onStyleFailure(event) {
      console.log(`style_result: ${event.type} fail (${summarizeReason(event.reason)})`);
    },
    onStyleSuccess(event) {
      console.log(`style_result: ${event.type} pass (model ${event.probeModel}, probe ${event.probeLatencyMs} ms)`);
    },
  };
}

function maskApiKey(apiKey) {
  if (!apiKey || apiKey.length <= 10) {
    return apiKey;
  }

  return `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`;
}

function summarizeReason(reason) {
  const singleLine = String(reason ?? 'unknown error').replace(/\s+/g, ' ').trim();
  return singleLine.length > 180 ? `${singleLine.slice(0, 177)}...` : singleLine;
}