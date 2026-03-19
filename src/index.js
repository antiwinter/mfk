#!/usr/bin/env node

import { buildProgram } from './cli/program.js';

const program = buildProgram();

await program.parseAsync(process.argv);