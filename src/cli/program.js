import { Command } from 'commander';
import { registerAddCommand } from './commands/add.js';
import { registerServeCommand } from './commands/serve.js';
import { registerTestCommand } from './commands/test.js';

export function buildProgram() {
  const program = new Command();

  program
    .name('mfk')
    .description('Route LLM requests across multiple providers and API keys')
    .option('-c, --config <path>', 'Path to the JSON config file', 'mfk.config.json');

  registerServeCommand(program);
  registerTestCommand(program);
  registerAddCommand(program);

  return program;
}