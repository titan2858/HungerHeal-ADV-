import { createApp } from './app.js';
import { ROUTES } from './config/routes.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

const server = createApp().listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, routes: ROUTES.length },
    'api-gateway listening - one entry point for the whole system',
  );
});

// The gateway holds no state, so shutdown only needs to stop accepting new
// connections and let in-flight requests finish.
const shutdown = (signal) => {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
