import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  SERVICE_NAME: z.string().default('api-gateway'),

  // The gateway verifies tokens itself, so it needs the same secret every
  // other service uses.
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),

  AUTH_SERVICE_URL: z.string().default('http://localhost:4001'),
  DONATION_SERVICE_URL: z.string().default('http://localhost:4002'),
  GEOCODING_SERVICE_URL: z.string().default('http://localhost:4003'),
  LOCATION_SERVICE_URL: z.string().default('http://localhost:4004'),
  ENGINE_SERVICE_URL: z.string().default('http://localhost:4005'),
  TRACKING_SERVICE_URL: z.string().default('http://localhost:4006'),
  NOTIFICATION_SERVICE_URL: z.string().default('http://localhost:4007'),
  ANALYTICS_SERVICE_URL: z.string().default('http://localhost:4008'),

  // Generous, because a donor posting five photos is a legitimate burst.
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  // Much tighter on auth: repeated guessing is only useful to an attacker.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  PROXY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`[api-gateway] invalid configuration:\n${issues.join('\n')}`);
  process.exit(1);
}

export const env = parsed.data;
