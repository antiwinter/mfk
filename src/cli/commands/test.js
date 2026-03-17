import { loadConfig } from '../../config/store.js';
import { discoverProviderModels, probeProviderModel } from '../../providers/discovery.js';

export function registerTestCommand(program) {
  program
    .command('test <providerName> [model]')
    .description('Test provider connectivity, report discovered models, and optionally probe one model')
    .action(async (...args) => {
      const providerName = args[0];
      const model = args[1];
      const command = args.at(-1);
      const configPath = command.optsWithGlobals().config;
      const { config } = await loadConfig(configPath);
      const provider = config.providers.find((entry) => entry.name === providerName);

      if (!provider) {
        throw new Error(`Unknown provider: ${providerName}`);
      }

      if (provider.keys.length === 0) {
        throw new Error(`Provider ${providerName} has no keys configured`);
      }
      const result = await discoverProviderModels(provider);

      console.log(`provider: ${provider.name}`);
      console.log(`type: ${provider.type}`);
      console.log(`key: ${result.key.name}`);
      console.log(`status: ok`);
      console.log(`source: live_api`);
      console.log(`latency_ms: ${result.latencyMs}`);

      if (model) {
        const probe = await probeProviderModel(provider, result.key, model);
        const probeText = extractProbeText(probe.response);

        console.log(`model: ${model}`);
        console.log('prompt: Return exactly: MFK model probe ok');
        console.log(`probe_response: ${probeText || '(empty response)'}`);
        console.log(`probe_latency_ms: ${probe.latencyMs}`);
        console.log('probe_status: ok');
        return;
      }

      if (result.models.length === 0) {
        console.log('models: (none reported)');
        return;
      }

      console.log('models:');
      for (const model of result.models) {
        console.log(model);
      }
    });
}

function extractProbeText(response) {
  if (!Array.isArray(response?.choices) || response.choices.length === 0) {
    return '';
  }

  return response.choices
    .map((choice) => choice?.message?.content ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
}