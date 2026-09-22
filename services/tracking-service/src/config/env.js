import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4006),
  SERVICE_NAME: z.string().default('tracking-service'),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  // Its own database. tracking-service owns the status lifecycle; it does not
  // reach into donation-service's collection to change it.
  MONGO_DB_NAME: z.string().default('hh_tracking'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  KAFKA_BROKERS: z.string().default('localhost:29092'),
  KAFKA_CLIENT_ID: z.string().default('tracking-service'),
  // Its OWN consumer group. A different group from assignment-engine means both
  // services receive every event independently, rather than splitting them.
  KAFKA_CONSUMER_GROUP: z.string().default('tracking-service'),
  KAFKA_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  // How long a processed-event marker is kept.
  DEDUP_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`[tracking-service] invalid configuration:\n${issues.join('\n')}`);
  process.exit(1);
}

export const env = parsed.data;
export const kafkaBrokers = env.KAFKA_BROKERS.split(',').map((b) => b.trim()).filter(Boolean);
