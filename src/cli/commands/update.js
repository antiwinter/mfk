import { findProvider, formatProviderRef, loadConfig, saveConfig } from '../../config/store.js';
import { detectProviderConfiguration } from '../../engines/discovery.js';

export function registerUpdateCommand(program) {
  program
    .command('update <providerRef>')
    .helpGroup('Providers')
    .description('Re-detect API style and refresh the model list for an existing provider')
    .option('-m, --model <model>', 'Known working model to probe when the provider does not expose /models')
    .action(async (...args) => {
      const [providerRef] = args;
      const command = args.at(-1);
      const configPath = program.opts().config;
      const knownModel = command.opts().model?.trim() || null;
      const { config } = await loadConfig(configPath);
      const provider = findProvider(config, providerRef);

      if (!provider) {
        throw new Error(`Unknown provider: ${providerRef}`);
      }

      const reporter = createDetectionReporter();

      console.log(`provider: ${formatProviderRef(provider)}`);
      console.log(`base_url: ${provider.baseUrl}`);
      console.log(`provider_key: ${maskApiKey(provider.apiKey)}`);
      console.log('source: live_api');
      if (knownModel) {
        console.log(`known_model: ${knownModel}`);
      }
      console.log('detecting_api_style: start');

      const detected = await detectProviderConfiguration({
        baseProvider: {
          ...provider,
          reporter,
        },
        key: provider.key,
        knownModel,
      });

      provider.type = detected.type;
      provider.models = detected.models;

      await saveConfig(configPath, config);
      console.log(`type: ${detected.type}`);
      console.log(`model_list_latency_ms: ${detected.listLatencyMs ?? 'unavailable'}`);
      console.log(`probe_model: ${detected.probeModel}`);
      console.log(`probe_prompt: ${detected.prompt}`);
      console.log(`probe_latency_ms: ${detected.probeLatencyMs}`);
      console.log(`models: ${detected.models.join(', ') || '(none reported)'}`);
    });
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
