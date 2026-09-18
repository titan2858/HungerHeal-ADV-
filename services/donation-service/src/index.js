import { createApp } from './app.js';
import { connectDb, disconnectDb } from './config/db.js';
import { connectProducer, disconnectProducer } from './config/kafka.js';
import { startOutboxSweeper, stopOutboxSweeper } from './events/outbox.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

async function main() {
  await connectDb();

  // Kafka is connected on a best-effort basis. A broker that is slow to start
  // must not stop this service from accepting donations - they are saved either
  // way and their events replayed once the connection is up. Treating Kafka as
  // a hard startup dependency would recreate exactly the coupling that using a
  // message bus was meant to remove.
  try {
    await connectProducer();
  } catch (err) {
    logger.error(
      { err: err.message },
      'kafka producer failed to connect at startup - donations will still be accepted and their events retried',
    );
  }

  startOutboxSweeper();

  const server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'donation-service listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    stopOutboxSweeper();
    server.close(async () => {
      // Disconnecting the producer flushes anything still buffered, so events
      // are not lost to a restart.
      await disconnectProducer();
      await disconnectDb();
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
