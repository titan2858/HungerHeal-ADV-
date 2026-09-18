import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { donationRouter } from './routes/donation.routes.js';
import { uploadDir } from './middleware/upload.js';
import { isKafkaConnected } from './config/kafka.js';
import { env } from './config/env.js';

export function createApp() {
  const app = express();

  app.use(
    helmet({
      // Uploaded images are served from this origin and rendered by the React
      // app on another one; the default same-origin policy would block them.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.use(requestContext);

  // Donation photos, served straight off disk.
  //
  // Fine for this project; the honest production answer is object storage (S3
  // or similar) behind a CDN, because local disk does not survive a container
  // being replaced and does not work at all once this service runs as more than
  // one instance.
  app.use(
    '/uploads',
    express.static(uploadDir, {
      maxAge: '7d',
      // Never let a request for /uploads/../src/config/env.js escape the folder.
      dotfiles: 'deny',
      index: false,
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: env.SERVICE_NAME });
  });

  // Kafka is reported but deliberately does NOT make this service unready:
  // donations are still accepted while the broker is down and their events are
  // replayed by the outbox sweeper. Refusing traffic would throw away donations
  // that the design is specifically built to keep.
  app.get('/ready', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({
      status: dbUp ? 'ready' : 'not-ready',
      dependencies: {
        mongo: dbUp ? 'up' : 'down',
        kafka: isKafkaConnected() ? 'up' : 'down (events will be queued and retried)',
      },
    });
  });

  app.use('/donations', donationRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
