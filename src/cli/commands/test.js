import { findProvider, formatProviderRef, loadConfig } from '../../config/store.js';
import { discoverProviderModels, probeProviderModel } from '../../engines/discovery.js';

export function registerTestCommand(program) {
  program
    .command('test <providerRef> [model]')
    .description('Test provider connectivity, report discovered models, and optionally probe one model')
    .action(async (...args) => {
      const providerRef = args[0];
      const model = args[1];
      const command = args.at(-1);
      const configPath = command.optsWithGlobals().config;
      const { config } = await loadConfig(configPath);
      const provider = findProvider(config, providerRef);

      if (!provider) {
        throw new Error(`Unknown provider: ${providerRef}`);
      }

      if (provider.keys.length === 0) {
        throw new Error(`Provider ${providerRef} has no keys configured`);
      }
      const result = await discoverProviderModels(provider);

      if (model) {
        const probe = await probeProviderModel(provider, result.key, model, {
          echo: {
            enabled: true,
          },
        });

        console.log(`probe_latency_ms: ${probe.latencyMs}`);
        console.log('probe_status: ok');
        return;
      }

  console.log(`provider: ${formatProviderRef(provider)}`);
  console.log(`url: ${provider.baseUrl}`);
      console.log(`type: ${provider.type}`);
      console.log(`status: ok`);
      console.log(`source: live_api`);
      console.log(`latency_ms: ${result.latencyMs}`);

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