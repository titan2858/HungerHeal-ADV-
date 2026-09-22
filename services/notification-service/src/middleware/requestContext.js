import { randomUUID } from 'node:crypto';
import { childLogger } from '../utils/logger.js';

// Gives every request a traceId and a logger already bound to it.
//
// An incoming x-trace-id is REUSED rather than replaced, which is what makes
// cross-service tracing work: api-gateway generates the id, forwards it to
// donation-service, which stamps it onto the donation.created Kafka event, and
// assignment-engine logs under the same id. One grep then shows a single
// donation's entire journey through the system.
export function requestContext(req, res, next) {
  const traceId = req.get('x-trace-id') || randomUUID();

  req.traceId = traceId;
  req.log = childLogger({ traceId });
  // Echo it back so the caller (and the browser network tab) can see it.
  res.set('x-trace-id', traceId);

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    req.log.info(
      {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      },
      'request completed',
    );
  });

  next();
}
