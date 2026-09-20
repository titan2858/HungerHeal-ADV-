import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { geocodeRouter } from './routes/geocode.routes.js';
import { isRedisReady } from './config/redis.js';
import { activeProvider } from './providers/index.js';
import { env } from './config/env.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '32kb' }));
  app.use(requestContext);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: env.SERVICE_NAME, provider: activeProvider });
  });

  // Redis is reported but does NOT make this service unready. A cache outage
  // means slower, costlier lookups - not wrong ones - so refusing traffic
  // would turn a performance problem into an availability one.
  app.get('/ready', (_req, res) => {
    res.json({
      status: 'ready',
      provider: activeProvider,
      dependencies: {
        redis: isRedisReady() ? 'up' : 'down (lookups will bypass the cache)',
      },
    });
  });

  app.use('/', geocodeRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
