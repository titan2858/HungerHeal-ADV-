import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';

import { requestContext } from './middleware/requestContext.js';
import { verifyToken } from './middleware/verifyToken.js';
import { ROUTES, HEALTH_TARGETS } from './config/routes.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

export function createApp() {
  const app = express();

  // Behind one proxy in this setup. Without this, express-rate-limit would see
  // every request as coming from the proxy's IP and rate limit the whole world
  // as a single client.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The frontend is served from the same origin in production, but donation
      // photos are fetched cross-origin during development.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cors());

  // NOTE: no express.json() here, deliberately.
  //
  // Parsing the body would consume the request stream, and the proxy would then
  // forward an empty body downstream - a classic and baffling gateway bug. The
  // gateway routes and authenticates; it does not need to read payloads, so the
  // stream is left untouched for http-proxy-middleware to pipe.
  app.use(requestContext);

  const generalLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'too many requests' } },
  });

  // Much tighter on auth. This is the one place where guessing repeatedly is
  // useful to an attacker, and it is the reason Phase 1 deliberately left rate
  // limiting to the gateway rather than implementing it per-service: one policy
  // at the edge covers every service, including ones not written yet.
  const authLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.AUTH_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true, // only failed attempts count toward the limit
    message: {
      error: { code: 'RATE_LIMITED', message: 'too many attempts; try again shortly' },
    },
  });

  // ------------------------------------------------------------ health
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: env.SERVICE_NAME });
  });

  // One call that answers "is the system up?" instead of seven separate curls.
  app.get('/ready', async (req, res) => {
    const results = await Promise.all(
      HEALTH_TARGETS.map(async (target) => {
        try {
          const response = await fetch(`${target.url}/health`, {
            signal: AbortSignal.timeout(3000),
          });
          return { name: target.name, status: response.ok ? 'up' : `http ${response.status}` };
        } catch {
          return { name: target.name, status: 'down' };
        }
      }),
    );

    const down = results.filter((r) => r.status !== 'up');

    // 503 when anything is down, so a container orchestrator or a demo script
    // can wait on this one endpoint rather than polling each service.
    res.status(down.length === 0 ? 200 : 503).json({
      status: down.length === 0 ? 'ready' : 'degraded',
      services: Object.fromEntries(results.map((r) => [r.name, r.status])),
      traceId: req.traceId,
    });
  });

  // ------------------------------------------------------------ proxies
  for (const route of ROUTES) {
    const middleware = [];

    if (route.rateLimit === 'auth') {
      middleware.push(authLimiter);
    } else {
      middleware.push(generalLimiter);
    }

    middleware.push(verifyToken(route.auth));

    middleware.push(
      createProxyMiddleware({
        target: route.target,
        changeOrigin: true,
        // Express has already stripped route.prefix from the path, so the
        // service's own base path is prepended rather than substituted.
        pathRewrite: (path) => `${route.basePath}${path}`,
        proxyTimeout: env.PROXY_TIMEOUT_MS,
        timeout: env.PROXY_TIMEOUT_MS,

        on: {
          proxyReq: (proxyReq, req) => {
            // The traceId continues through the gateway rather than restarting
            // here, so one id still follows a request across every service.
            if (req.traceId) proxyReq.setHeader('x-trace-id', req.traceId);

            // The decoded identity, forwarded downstream. Services still verify
            // the token themselves - defence in depth, and they must keep
            // working when called directly - but this is what would let them
            // stop, and it is why no service ever calls auth-service to ask
            // "who is this?".
            if (req.user) {
              proxyReq.setHeader('x-user-id', req.user.id ?? '');
              proxyReq.setHeader('x-user-role', req.user.role ?? '');
            }
          },

          error: (err, req, res) => {
            const message = route.optional
              ? `${route.prefix} is not available in this deployment`
              : 'the service behind this route is unavailable';

            logger.error(
              { err: err.message, prefix: route.prefix, target: route.target },
              'proxy error',
            );

            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
            }
            res.end(
              JSON.stringify({
                error: { code: 'BAD_GATEWAY', message, traceId: req.traceId },
              }),
            );
          },
        },
      }),
    );

    app.use(route.prefix, ...middleware);
  }

  // Anything not matched by a route above.
  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `no route for ${req.method} ${req.originalUrl}`,
        traceId: req.traceId,
      },
    });
  });

  return app;
}
