import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// donation-service owns the donations collection outright, in its OWN database
// (hh_donations), separate from auth-service's hh_auth. No service reads
// another's database directly - that rule is what keeps "microservices" from
// collapsing into a shared-database monolith with extra network hops.
//
// The visible consequence: a donation stores only donorId, not a join to the
// users collection. Anything more about the donor comes from the JWT or from
// asking auth-service.
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
