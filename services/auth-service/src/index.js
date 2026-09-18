import { createApp } from './app.js';
import { connectDb, disconnectDb } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
  
async function main() {
  // Connect before listening: a service that accepts requests it cannot serve
  // just turns a startup problem into a pile of 500s.
  await connectDb();
 
  const server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'auth-service listening');
  });

  // Graceful shutdown. `docker compose down` sends SIGTERM; without this the
  // process is killed mid-request and Mongo connections are left dangling.
  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    // Do not hang forever if a connection refuses to close.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'failed to start');
  process.exit(1);
});
