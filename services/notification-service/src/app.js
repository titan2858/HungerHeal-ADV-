import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { notificationRouter } from './routes/notification.routes.js';
import { isRedisReady } from './config/redis.js';
import { isKafkaConnected } from './events/consumer.js';
import { env } from './config/env.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));
  app.use(requestContext);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: env.SERVICE_NAME });
  });

  // Mongo is required - there is nowhere else to keep notifications. Kafka and
  // Redis are reported but do not make the service unready: an inbox of
  // already-delivered notifications is still worth serving while the pipeline
  // catches up.
  app.get('/ready', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({
      status: dbUp ? 'ready' : 'not-ready',
      dependencies: {
        mongo: dbUp ? 'up' : 'down',
        kafka: isKafkaConnected() ? 'up' : 'down (events will resume on reconnect)',
        redis: isRedisReady() ? 'up' : 'down (dedup degraded)',
      },
    });
  });

  app.use('/notifications', notificationRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
