import { spawnSync } from 'node:child_process';

const filters = parseFilters(process.argv.slice(2));
const env = {
  ...process.env,
  ...(filters.inbound ? { MFK_TEST_INBOUND: filters.inbound } : {}),
  ...(filters.outbound ? { MFK_TEST_OUTBOUND: filters.outbound } : {}),
  ...(filters.model ? { MFK_TEST_MODEL: filters.model } : {}),
  ...(filters.mode ? { MFK_TEST_MODE: filters.mode } : {}),
};

const result = spawnSync(process.execPath, ['--test', 'tests/integration.test.js'], {
  stdio: 'inherit',
  env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

function parseFilters(argv) {
  const filters = {
    inbound: null,
    outbound: null,
    model: null,
    mode: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const [flag, inlineValue] = arg.split('=', 2);
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }

    if (!inlineValue) {
      index += 1;
    }

    if (flag === '--inbound') {
      filters.inbound = value;
    } else if (flag === '--outbound') {
      filters.outbound = value;
    } else if (flag === '--model') {
      filters.model = value;
    } else if (flag === '--mode') {
      filters.mode = value;
    } else {
      throw new Error(`Unknown integration filter: ${flag}`);
    }
  }

  return filters;
}