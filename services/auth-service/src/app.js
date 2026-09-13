import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './routes/auth.routes.js';
import { env } from './config/env.js';

// The Express app is built separately from the server that listens on a port
// (see index.js). That split is what lets the tests drive the app in-process
// via supertest without binding a port or racing on one.
export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  // First in the chain: everything after this can use req.log and req.traceId.
  app.use(requestContext);

  // Liveness: is the process up at all? Used by docker-compose's healthcheck.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: env.SERVICE_NAME });
  });

  // Readiness: can this service actually serve traffic? It cannot without
  // Mongo, so a dependency check belongs here and NOT in /health - otherwise
  // the container gets restarted for an outage it did not cause.
  app.get('/ready', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({
      status: dbUp ? 'ready' : 'not-ready',
      dependencies: { mongo: dbUp ? 'up' : 'down' },
    });
  });

  app.use('/auth', authRouter);

  // Order matters: unmatched routes become a 404 error, then the single error
  // handler formats every error uniformly. Both must come last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
