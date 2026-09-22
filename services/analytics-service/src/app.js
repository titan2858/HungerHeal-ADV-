import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { analyticsRouter } from './routes/analytics.routes.js';
import { isCassandraReady } from './config/cassandra.js';
import { isRedisReady } from './config/redis.js';
import { isKafkaConnected } from './events/consumer.js';
import { env } from './config/env.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '32kb' }));
  app.use(requestContext);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: env.SERVICE_NAME });
  });

  // Cassandra IS required here - it is the only place this service keeps
  // anything. Unlike the donation path, though, nothing else in the system
  // depends on analytics being up: if this service is down, donations are
  // still created, matched and collected, and the events wait in Kafka to be
  // consumed when it returns.
  app.get('/ready', (_req, res) => {
    const up = isCassandraReady();
    res.status(up ? 200 : 503).json({
      status: up ? 'ready' : 'not-ready',
      dependencies: {
        cassandra: up ? 'up' : 'down',
        kafka: isKafkaConnected() ? 'up' : 'down (events will resume on reconnect)',
        redis: isRedisReady() ? 'up' : 'down (dedup degraded)',
      },
    });
  });

  app.use('/analytics', analyticsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
