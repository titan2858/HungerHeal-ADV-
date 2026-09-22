import pino from 'pino';
import { env } from '../config/env.js';

// Structured JSON logging from Phase 1 onward (docs/PLAN.md section 5).
//
// Every log line carries a traceId, so one donation's journey across all the
// services can be followed with:
//   docker compose logs | grep <traceId>
// This is the cheap version of distributed tracing, and for this project's
// scope it replaces needing Grafana/Loki.
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: env.SERVICE_NAME },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Never let a password or token reach the logs, even if a caller passes one
  // into a log object by mistake.
  redact: {
    paths: ['password', 'passwordHash', 'token', 'req.headers.authorization', '*.password'],
    censor: '[REDACTED]',
  },
});

// A child logger bound to one request's traceId, so no call site has to
// remember to attach it.
export const childLogger = (bindings) => logger.child(bindings);
