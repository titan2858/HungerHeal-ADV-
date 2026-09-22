import { createApp } from './app.js';
import { connectDb, disconnectDb } from './config/db.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { startConsumer, stopConsumer } from './events/consumer.js';
import { connectProducer, disconnectProducer } from './events/producer.js';
import { buildHandlers, TOPICS } from './events/handlers.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

async function main() {
  await connectDb();

  try {
    await connectRedis();
  } catch (err) {
    logger.error({ err: err.message }, 'redis unavailable - dedup will be degraded');
  }

  try {
    await connectProducer();
    await startConsumer(TOPICS, buildHandlers());
  } catch (err) {
    // The read API is still worth serving: a donor checking on yesterday's
    // donation does not care that the broker is briefly down.
    logger.error({ err: err.message }, 'kafka unavailable at startup - the read API will still serve');
  }

  const server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, topics: TOPICS.length }, 'tracking-service listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    // The consumer stops first, so no event is half-applied while Mongo is
    // being closed underneath it.
    await stopConsumer().catch(() => {});
    server.close(async () => {
      await disconnectProducer().catch(() => {});
      await disconnectRedis().catch(() => {});
      await disconnectDb().catch(() => {});
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
