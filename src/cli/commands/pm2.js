import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const MAIN_SCRIPT = path.resolve(path.dirname(__filename), '../../index.js');
const PM2_APP_NAME = 'mfk';

function requirePm2() {
  try {
    execFileSync('pm2', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('pm2 is not installed. Install it with:');
    console.error('  npm install -g pm2');
    process.exit(1);
  }
}

function findMfkProcess() {
  try {
    const output = execFileSync('pm2', ['jlist'], { encoding: 'utf8' });
    const list = JSON.parse(output);
    return list.find(p => p.name === PM2_APP_NAME) ?? null;
  } catch {
    return null;
  }
}

function pm2(...args) {
  execFileSync('pm2', args, { stdio: 'inherit' });
}

export function registerLogsCommand(program) {
  program
    .command('logs')
    .helpGroup('Server')
    .description('Stream mfk server logs via pm2')
    .action(() => {
      requirePm2();
      if (!findMfkProcess()) {
        console.error(`No pm2 process '${PM2_APP_NAME}' found. Run 'mfk start' first.`);
        process.exit(1);
      }
      const child = spawn('pm2', ['logs', PM2_APP_NAME], { stdio: 'inherit' });
      child.on('exit', code => process.exit(code ?? 0));
    });
}

export function registerStartCommand(program) {
  program
    .command('start')
    .helpGroup('Server')
    .description('Start the mfk server via pm2 (restarts if already registered)')
    .option('--host <host>', 'Host to bind to')
    .option('--port <port>', 'Port to bind to')
    .option('--dump', 'Print request dump to stdout')
    .action((options) => {
      requirePm2();
      const configPath = program.opts().config;

      if (findMfkProcess()) {
        pm2('restart', PM2_APP_NAME);
      } else {
        const scriptArgs = ['--config', configPath, 'serve'];
        if (options.host) scriptArgs.push('--host', options.host);
        if (options.port) scriptArgs.push('--port', String(options.port));
        if (options.dump) scriptArgs.push('--dump');

        pm2(
          'start', MAIN_SCRIPT,
          '--name', PM2_APP_NAME,
          '--interpreter', process.execPath,
          '--',
          ...scriptArgs,
        );
      }

      pm2('save');
    });
}

export function registerStopCommand(program) {
  program
    .command('stop')
    .helpGroup('Server')
    .description('Stop the mfk server via pm2')
    .action(() => {
      requirePm2();
      if (!findMfkProcess()) {
        console.error(`No pm2 process '${PM2_APP_NAME}' found. Run 'mfk start' first.`);
        process.exit(1);
      }
      pm2('stop', PM2_APP_NAME);
      pm2('save');
    });
}

export function registerRestartCommand(program) {
  program
    .command('restart')
    .helpGroup('Server')
    .description('Restart the mfk server via pm2')
    .action(() => {
      requirePm2();
      if (!findMfkProcess()) {
        console.error(`No pm2 process '${PM2_APP_NAME}' found. Run 'mfk start' first.`);
        process.exit(1);
      }
      pm2('restart', PM2_APP_NAME);
      pm2('save');
    });
}
