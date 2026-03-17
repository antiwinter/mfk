import { loadConfig, saveConfig } from '../../config/store.js';
import { detectProviderConfiguration } from '../../providers/discovery.js';

export function registerAddCommand(program) {
  program
    .command('add <urlPort> <key>')
    .description('Add a provider by auto-detecting its API style and importing its model list')
    .option('--name <name>', 'Override the generated provider name')
    .action(async (...args) => {
      const [urlPort, apiKey, options] = args;
      const command = args.at(-1);
      const configPath = command.optsWithGlobals().config;
      const { config } = await loadConfig(configPath);
      const baseUrl = normalizeBaseUrl(urlPort);
      const existingProvider = config.providers.find((provider) => provider.baseUrl === baseUrl);

      const probeProvider = existingProvider ?? {
        name: options.name ?? createProviderName(baseUrl, config.providers),
        type: 'openai-compatible',
        baseUrl,
        priority: 100,
        quotaReset: 'daily',
        failureReset: 'hourly',
        headers: {},
        models: [],
        keys: [],
      };

      const tempKey = {
        name: createKeyName(probeProvider.keys),
        value: apiKey,
        priority: 100,
      };
      const detected = await detectProviderConfiguration({
        baseProvider: probeProvider,
        key: tempKey,
      });
      const models = detected.models;

      if (existingProvider) {
        existingProvider.type = detected.type;
        existingProvider.keys.push(tempKey);
        existingProvider.models = models;
      } else {
        probeProvider.type = detected.type;
        probeProvider.models = models;
        probeProvider.keys.push(tempKey);
        config.providers.push(probeProvider);
      }

      await saveConfig(configPath, config);
      console.log(`provider: ${existingProvider?.name ?? probeProvider.name}`);
      console.log(`type: ${detected.type}`);
      console.log(`base_url: ${baseUrl}`);
      console.log(`key: ${tempKey.name}`);
      console.log(`source: live_api`);
      console.log(`model_list_latency_ms: ${detected.listLatencyMs}`);
      console.log(`probe_model: ${detected.probeModel}`);
      console.log(`probe_prompt: ${detected.prompt}`);
      console.log(`probe_latency_ms: ${detected.probeLatencyMs}`);
      console.log(`models: ${models.join(', ') || '(none reported)'}`);
    });
}

function normalizeBaseUrl(value) {
  return /^https?:\/\//.test(value) ? value.replace(/\/$/, '') : `http://${value.replace(/\/$/, '')}`;
}

function createProviderName(baseUrl, providers) {
  const hostname = new URL(baseUrl).host.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const baseName = `provider-${hostname || 'local'}`;
  let name = baseName;
  let index = 2;

  while (providers.some((provider) => provider.name === name)) {
    name = `${baseName}-${index}`;
    index += 1;
  }

  return name;
}

function createKeyName(keys) {
  let index = keys.length + 1;
  let name = `key-${index}`;

  while (keys.some((entry) => entry.name === name)) {
    index += 1;
    name = `key-${index}`;
  }

  return name;
}