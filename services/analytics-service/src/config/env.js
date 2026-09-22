import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4008),
  SERVICE_NAME: z.string().default('analytics-service'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  CASSANDRA_HOSTS: z.string().default('localhost:9042'),
  CASSANDRA_DATACENTER: z.string().default('datacenter1'),
  CASSANDRA_USER: z.string().default(''),
  CASSANDRA_PASSWORD: z.string().default(''),

  KAFKA_BROKERS: z.string().default('localhost:29092'),
  KAFKA_CLIENT_ID: z.string().default('analytics-service'),
  // Its own group. This service was added last and required no change to any
  // producer, because a new consumer group receives the whole stream.
  KAFKA_CONSUMER_GROUP: z.string().default('analytics-service'),
  KAFKA_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  DEDUP_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`[analytics-service] invalid configuration:\n${issues.join('\n')}`);
  process.exit(1);
}

export const env = parsed.data;
export const kafkaBrokers = env.KAFKA_BROKERS.split(',').map((b) => b.trim()).filter(Boolean);
