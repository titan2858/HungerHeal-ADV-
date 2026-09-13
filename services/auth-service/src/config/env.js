import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// Validate configuration at boot and crash immediately if something is wrong.
// A service that starts with a missing JWT_SECRET and only fails on the first
// login attempt is far harder to diagnose than one that refuses to start.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4001),
  SERVICE_NAME: z.string().default('auth-service'),
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  MONGO_DB_NAME: z.string().default('hh_auth'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  // 'silent' is a real pino level (no output at all) and is what the test suite uses.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`[auth-service] invalid configuration:\n${issues.join('\n')}`);
  process.exit(1);
}

export const env = parsed.data;
