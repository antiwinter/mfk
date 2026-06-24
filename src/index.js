#!/usr/bin/env node

import { buildProgram } from './cli/program.js';

// When no subcommand is given, treat all args as `mfk ls` args.
// This makes `mfk -lk` == `mfk ls -lk` and `mfk -h` == `mfk ls -h`.
// Use `mfk help` for global help.
function injectLs(argv, commandNames) {
  const args = argv.slice(2);
  let insertAt = 0;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') break;
    // Skip known global options that consume the next token
    if (arg === '-c' || arg === '--config') { i += 2; insertAt = i; continue; }
    if (arg.startsWith('--config=')) { i += 1; insertAt = i; continue; }
    if (!arg.startsWith('-')) {
      // First positional arg: if it's already a known subcommand, do nothing
      if (commandNames.has(arg)) return argv;
      const result = [...args];
      result.splice(i, 0, 'ls');
      return [...argv.slice(0, 2), ...result];
    }
    i++;
  }

  // No positional found — inject ls after any consumed global options
  const result = [...args];
  result.splice(insertAt, 0, 'ls');
  return [...argv.slice(0, 2), ...result];
}

const program = buildProgram();
const commandNames = new Set(program.commands.flatMap(c => [c.name(), ...c.aliases()]));
await program.parseAsync(injectLs(process.argv, commandNames));
