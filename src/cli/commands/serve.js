import { createDatabase } from '../../db/client.js';
import { loadConfig, resolveDatabasePath } from '../../config/store.js';
import { createServer } from '../../server/app.js';

export function registerServeCommand(program) {
  program
    .command('serve')
    .description('Start the local MFK HTTP gateway')
    .option('--host <host>', 'Host to bind to')
    .option('--port <port>', 'Port to bind to', parseNumber)
    .action(async (options, command) => {
      const configPath = program.opts().config;
      const { config, dir } = await loadConfig(configPath);
      const dbPath = resolveDatabasePath(dir, config.database.path);
      const db = createDatabase(dbPath);
      const host = options.host ?? config.server.host;
      const port = options.port ?? config.server.port;
      const app = createServer({ config, db });

      const close = async () => {
        await app.close();
        db.close();
      };

      process.once('SIGINT', close);
      process.once('SIGTERM', close);

      await app.listen({ host, port });
      console.log(`mfk listening on http://${host}:${port}`);
    });
}

function parseNumber(value) {
  return Number.parseInt(value, 10);
}