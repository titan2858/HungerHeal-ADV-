import { createApp } from './app.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { env } from './config/env.js';
import { activeProvider } from './providers/index.js';
import { logger } from './utils/logger.js';

async function main() {
  // Best-effort: without Redis this service still answers correctly, just
  // without the cache, so a Redis outage must not stop it from starting.
  try {
    await connectRedis();
  } catch (err) {
    logger.error({ err: err.message }, 'redis unavailable at startup - running uncached');
  }

  if (activeProvider === 'offline') {
    logger.warn(
      'using the OFFLINE geocoder - set OPENCAGE_API_KEY in .env for real addresses',
    );
  }

  const server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, provider: activeProvider }, 'geocoding-service listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await disconnectRedis();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'failed to start');
  process.exit(1);
});
