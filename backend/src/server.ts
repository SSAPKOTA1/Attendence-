import { config } from './config';
import { createApp } from './app';
import { logger } from './logger';
import { startJobs } from './jobs';
import { closePool } from './db/pool';

const app = createApp();
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'listening'));
const stopJobs = config.JOBS_ENABLED ? startJobs() : () => undefined;

process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception, shutting down');
  process.exit(1);
});

function shutdown() {
  stopJobs();
  server.close(() => {
    void closePool().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
