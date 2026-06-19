import chalk from 'chalk';
import { findProvider, formatProviderKey, formatProviderRef, loadConfig } from '../../config/store.js';
import { discoverProviderModels, probeProviderModel } from '../../engines/discovery.js';
import { resolveProviderModel, normalizeModelId } from '../../lib/models.js';

function truncate(str, maxLen = 60) {
  const s = String(str ?? '').replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function trimModelDisplay(model) {
  return normalizeModelId(model).replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

async function testModel(provider, model) {
  try {
    // Resolve model the same way the router does: against the config provider's models list.
    // This validates that our routing logic would actually select the right model name.
    const resolved = resolveProviderModel(provider, model) ?? model;
    const probe = await probeProviderModel(provider, provider.key, resolved, {});
    const response = truncate(probe.response?.content ?? '');
    return { ok: true, response, latencyMs: probe.latencyMs, resolved };
  } catch (err) {
    return { ok: false, error: truncate(err.message) };
  }
}

function formatTestResult(result) {
  if (result.ok) {
    return chalk.green(`ok(${result.latencyMs}ms)`) + ' ' + chalk.dim(result.response);
  }
  return chalk.red('err') + ' ' + chalk.dim(result.error);
}

export function registerTestCommand(program) {
  program
    .command('test [ref]')
    .helpGroup('Providers')
    .description('Test provider/model connectivity. ref can be PROVIDER, MODEL, or PROVIDER/MODEL')
    .action(async (ref, _opts, cmd) => {
      const configPath = program.opts().config;
      const { config } = await loadConfig(configPath);

      if (!ref) {
        cmd.help();
        return;
      }

      // Parse ref: could be "PROVIDER/MODEL", "PROVIDER", or "MODEL"
      const slashIdx = ref.indexOf('/');
      let providerSelector = null;
      let modelSelector = null;

      if (slashIdx !== -1) {
        // Explicit PROVIDER/MODEL
        providerSelector = ref.slice(0, slashIdx);
        modelSelector = ref.slice(slashIdx + 1);
      } else {
        // Try as provider first
        try {
          const found = findProvider(config, ref);
          if (found) {
            providerSelector = ref;
          } else {
            modelSelector = ref;
          }
        } catch {
          // Ambiguous provider selector — treat as provider
          providerSelector = ref;
        }
      }

      if (providerSelector && modelSelector) {
        // mfk test PROVIDER/MODEL
        const provider = findProvider(config, providerSelector);
        if (!provider) {
          throw new Error(`Unknown provider: ${providerSelector}`);
        }
        if (!provider.key) {
          throw new Error(`Provider has no key configured`);
        }

        // Resolve against config provider models — same path as the router
        const resolved = resolveProviderModel(provider, modelSelector) ?? modelSelector;
        const result = await testModel(provider, resolved);

        const keyLabel = formatProviderKey(provider.apiKey);
        const modelLabel = trimModelDisplay(resolved);
        console.log(`${keyLabel}  ${modelLabel}  ${formatTestResult(result)}`);

      } else if (providerSelector) {
        // mfk test PROVIDER — test all models in parallel
        const provider = findProvider(config, providerSelector);
        if (!provider) {
          throw new Error(`Unknown provider: ${providerSelector}`);
        }
        if (!provider.key) {
          throw new Error(`Provider has no key configured`);
        }

        const discovery = await discoverProviderModels(provider);
        const models = (discovery.models ?? []).filter(m => m !== '*' && !String(m).endsWith('/*'));

        if (models.length === 0) {
          console.log('No concrete models found for provider');
          return;
        }

        const keyLabel = formatProviderKey(provider.apiKey);
        console.log(`${keyLabel}\t${chalk.green('live')}\t${provider.baseUrl}`);

        const results = await Promise.all(
          models.map(async (model) => {
            const result = await testModel(provider, model);
            return { model, result };
          })
        );

        for (const { model, result } of results) {
          console.log(`  ${trimModelDisplay(model)}\t${formatTestResult(result)}`);
        }

      } else {
        // mfk test MODEL — test all providers having that model in parallel
        const matchingProviders = config.providers.filter(p =>
          p.key && resolveProviderModel(p, modelSelector)
        );

        if (matchingProviders.length === 0) {
          console.log(`N/A — no provider configured for model: ${modelSelector}`);
          return;
        }

        const results = await Promise.all(
          matchingProviders.map(async (provider) => {
            const resolved = resolveProviderModel(provider, modelSelector);
            const result = await testModel(provider, resolved);
            return { provider, model: resolved, result };
          })
        );

        for (const { provider, model, result } of results) {
          const keyLabel = formatProviderKey(provider.apiKey);
          const modelLabel = trimModelDisplay(model);
          console.log(`${keyLabel}  ${modelLabel}  ${formatTestResult(result)}`);
        }
      }
    });
}
