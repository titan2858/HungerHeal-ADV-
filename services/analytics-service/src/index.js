import { createApp } from './app.js';
import { connectCassandra, disconnectCassandra } from './config/cassandra.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { startConsumer, stopConsumer } from './events/consumer.js';
import { buildHandlers, TOPICS } from './events/handlers.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

async function main() {
  // Cassandra first: there is nowhere else to put an event, so starting the
  // consumer before the store is ready would just drop everything it read.
  await connectCassandra();

  try {
    await connectRedis();
  } catch (err) {
    logger.error({ err: err.message }, 'redis unavailable - dedup will be degraded');
  }

  try {
    // fromBeginning, so a newly deployed analytics-service back-fills the whole
    // history rather than starting blind. This is the payoff of an event log:
    // the service was added last and still knows everything that ever
    // happened, with no migration written by anyone.
    await startConsumer(TOPICS, buildHandlers());
  } catch (err) {
    logger.error({ err: err.message }, 'kafka unavailable at startup - the read API will still serve');
  }

  const server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, topics: TOPICS.length }, 'analytics-service listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    await stopConsumer().catch(() => {});
    server.close(async () => {
      await disconnectRedis().catch(() => {});
      await disconnectCassandra().catch(() => {});
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
