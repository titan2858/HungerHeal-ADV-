import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4002),
  SERVICE_NAME: z.string().default('donation-service'),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  // A separate database from auth-service's. Each service owns its own data.
  MONGO_DB_NAME: z.string().default('hh_donations'),

  // Must match auth-service exactly, or every token it issues fails here.
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),

  // Comma-separated: kafka:9092 inside docker, localhost:29092 from the host.
  KAFKA_BROKERS: z.string().default('localhost:29092'),
  KAFKA_CLIENT_ID: z.string().default('donation-service'),
  // Set false in tests so the suite does not need a live broker.
  KAFKA_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // How often to retry publishing events that failed to reach Kafka.
  OUTBOX_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),

  // Phase 3: when a donation arrives without coordinates, ask
  // geocoding-service to derive them from the address.
  GEOCODING_URL: z.string().default('http://localhost:4003'),
  GEOCODING_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  GEOCODING_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  UPLOAD_DIR: z.string().default('uploads'),
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  MAX_IMAGES_PER_DONATION: z.coerce.number().int().positive().default(5),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`[donation-service] invalid configuration:\n${issues.join('\n')}`);
  process.exit(1);
}

export const env = parsed.data;
export const kafkaBrokers = env.KAFKA_BROKERS.split(',').map((b) => b.trim()).filter(Boolean);
