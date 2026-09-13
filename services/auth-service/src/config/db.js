import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// auth-service owns the users collection outright. No other service reads or
// writes this database directly - they ask auth-service, or they trust the JWT
// it issued. That rule is what keeps "microservices" from collapsing into a
// shared-database monolith with extra network hops.
export async function connectDb() {
  mongoose.connection.on('connected', () =>
    logger.info({ db: env.MONGO_DB_NAME }, 'mongo connected'));
  mongoose.connection.on('error', (err) =>
    logger.error({ err: err.message }, 'mongo connection error'));
  mongoose.connection.on('disconnected', () =>
    logger.warn('mongo disconnected'));

  await mongoose.connect(env.MONGO_URI, {
    dbName: env.MONGO_DB_NAME,
    // Fail fast instead of buffering queries for 30s when Mongo is unreachable.
    serverSelectionTimeoutMS: 5000,
  });

  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.connection.close();
}
