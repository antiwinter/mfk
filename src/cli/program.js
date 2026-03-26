import { Command } from 'commander';
import { DEFAULT_CONFIG_PATH } from '../config/store.js';
import { registerAddCommand } from './commands/add.js';
import { registerGenCommand } from './commands/gen.js';
import { registerListCommand } from './commands/list.js';
import { registerRenameCommand } from './commands/rename.js';
import { registerResetCommand } from './commands/reset.js';
import { registerRmCommand } from './commands/rm.js';
import { registerServeCommand } from './commands/serve.js';
import { registerTestCommand } from './commands/test.js';

export function buildProgram() {
  const program = new Command();

  program
    .name('mfk')
    .description('Route LLM requests across multiple providers and API keys')
    .option('-c, --config <path>', 'Path to the JSON config file', DEFAULT_CONFIG_PATH);

  registerServeCommand(program);
  registerTestCommand(program);
  registerAddCommand(program);
  registerGenCommand(program);
  registerListCommand(program);
  registerRenameCommand(program);
  registerResetCommand(program);
  registerRmCommand(program);

  return program;
}