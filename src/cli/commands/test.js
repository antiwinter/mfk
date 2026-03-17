import { loadConfig } from '../../config/store.js';
import { getProviderAdapter } from '../../providers/index.js';

export function registerTestCommand(program) {
  program
    .command('test <providerName>')
    .description('Test provider connectivity and report discovered models')
    .action(async (...args) => {
      const providerName = args[0];
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

      const adapter = getProviderAdapter(provider.type);
      let models = null;
      let lastError = null;

      for (const key of provider.keys) {
        try {
          models = await adapter.listModels(provider, key);
          console.log(`provider: ${provider.name}`);
          console.log(`type: ${provider.type}`);
          console.log(`key: ${key.name}`);
          console.log(`status: ok`);
          console.log(`models: ${models.join(', ') || '(none reported)'}`);
          return;
        } catch (error) {
          lastError = error;
        }
      }

      throw new Error(`Provider test failed: ${lastError?.message ?? 'unknown error'}`);
    });
}