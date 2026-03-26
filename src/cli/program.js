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

  // Move the help command into the Common section
  program.helpCommand(false);
  program
    .command('help [command]')
    .helpGroup('Common')
    .description('display help for command')
    .action((cmd) => {
      if (cmd) {
        const target = program.commands.find((c) => c.name() === cmd || c.aliases().includes(cmd));
        if (target) {
          target.help();
        } else {
          console.error(`error: unknown command '${cmd}'`);
          process.exit(1);
        }
      } else {
        program.help();
      }
    });

  return program;
}