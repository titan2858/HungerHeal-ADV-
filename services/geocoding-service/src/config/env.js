import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4003),
  SERVICE_NAME: z.string().default('geocoding-service'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  // 'auto' picks opencage when a key is present and the offline provider when
  // it is not, so the whole service works before anyone signs up for a key.
  GEOCODER_PROVIDER: z.enum(['auto', 'opencage', 'offline']).default('auto'),
  OPENCAGE_API_KEY: z.string().default(''),
  OPENCAGE_BASE_URL: z.string().default('https://api.opencagedata.com/geocode/v1/json'),
  // OpenCage over the public internet; fail fast rather than holding a donor's
  // submission open for 30 seconds.
  GEOCODER_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),

  // 30 days. A street address does not move, so a long TTL is safe and is what
  // makes the cache actually pay for itself.
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  // "Address not found" is cached too, but briefly - see cache/geocodeCache.js.
  NEGATIVE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60),

  // OpenCage's free tier allows 2500 requests/day. Exceeding it gets the key
  // suspended, so the service counts and stops on its own.
  DAILY_REQUEST_QUOTA: z.coerce.number().int().positive().default(2400),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  console.error(`[geocoding-service] invalid configuration:\n${issues.join('\n')}`);
  process.exit(1);
}

export const env = parsed.data;

// Resolved once at boot so every call site agrees on which provider is active.
export const activeProvider =
  env.GEOCODER_PROVIDER === 'auto'
    ? env.OPENCAGE_API_KEY
      ? 'opencage'
      : 'offline'
    : env.GEOCODER_PROVIDER;
