import { loadConfig } from '../../config/store.js';
import { applyOmpModelsYml, generateOmpModelsYml, ompModelsPath, renderOmpModelsYml } from '../wire/omp.js';

export function registerWireOmpCommand(program) {
  program
    .command('wire-omp')
    .helpGroup('Common')
    .description('Translate config.json providers/models into ~/.omp/agent/models.yml so omp can use them directly')
    .option('--dry-run', 'Print generated YAML to stdout without writing any files')
    .option('--out <path>', `Override the output file path (default ${ompModelsPath()})`)
    .action(async (options) => {
      const configPath = program.opts().config;
      const { config } = await loadConfig(configPath);
      const body = generateOmpModelsYml({ config });
      const yaml = renderOmpModelsYml(body);

      if (options.dryRun) {
        process.stdout.write(yaml);
        return;
      }

      const result = applyOmpModelsYml({ outPath: options.out, body: yaml.trimEnd() });
      if (result.action === 'wrote') {
        console.log(`wrote ${result.path}`);
        if (result.backupPath) {
          console.log(`backup (first time only): ${result.backupPath}`);
        }
      } else {
        console.log(`${result.action}: ${result.path}`);
      }
    });
}
