import { env } from './env.js';

// The routing table: one place that knows where every service lives.
//
// `auth: false` means the gateway forwards without requiring a token. That is
// not the same as "unprotected" - the downstream service still verifies the
// token for anything that needs one. It means the GATEWAY does not reject the
// request before it gets there, which matters for login and signup, where by
// definition the caller has no token yet.
//
// `basePath` maps the public path onto the service's own. The frontend talks to
// /api/auth/login; auth-service only knows about /auth/login.
//
// Express's app.use(prefix, ...) STRIPS the prefix before the middleware runs,
// so by the time the proxy sees it, /api/auth/login is already just /login.
// The rewrite therefore PREPENDS the service's base path rather than trying to
// substitute the public one - a regex against /api/auth would never match
// anything here, which is exactly the bug the smoke test caught.
export const ROUTES = [
  {
    prefix: '/api/auth',
    target: env.AUTH_SERVICE_URL,
    basePath: '/auth',
    // Login and signup cannot require a token.
    auth: false,
    // The one place worth rate limiting hard: it is the only endpoint where
    // guessing repeatedly is useful to an attacker.
    rateLimit: 'auth',
  },
  {
    prefix: '/api/donations',
    target: env.DONATION_SERVICE_URL,
    basePath: '/donations',
    auth: true,
  },
  {
    // Donation photos. Served without a token so an <img> tag works - the
    // filenames are random UUIDs, which is the same protection an object
    // store's signed-ish URLs would give at this scale.
    prefix: '/uploads',
    target: env.DONATION_SERVICE_URL,
    basePath: '/uploads',
    auth: false,
  },
  {
    prefix: '/api/geo',
    target: env.GEOCODING_SERVICE_URL,
    basePath: '',
    auth: true,
  },
  {
    prefix: '/api/location',
    target: env.LOCATION_SERVICE_URL,
    basePath: '',
    auth: true,
  },
  {
    prefix: '/api/engine',
    target: env.ENGINE_SERVICE_URL,
    basePath: '',
    auth: true,
  },
  {
    // Registered BEFORE /api/tracking, because both live on tracking-service
    // and Express matches prefixes in order. The other way round, /api/tracking
    // would swallow /api/monitoring requests.
    prefix: '/api/monitoring',
    target: env.TRACKING_SERVICE_URL,
    basePath: '/monitoring',
    auth: true,
  },
  {
    prefix: '/api/tracking',
    target: env.TRACKING_SERVICE_URL,
    basePath: '/tracking',
    auth: true,
  },
  {
    prefix: '/api/notify',
    target: env.NOTIFICATION_SERVICE_URL,
    basePath: '/notifications',
    auth: true,
  },
  {
    // Optional: analytics-service only runs under the "analytics" profile, so
    // this route may have nothing behind it. The gateway returns 502 rather
    // than crashing, which is the correct answer for a service that is not
    // deployed.
    prefix: '/api/analytics',
    target: env.ANALYTICS_SERVICE_URL,
    basePath: '/analytics',
    auth: true,
    optional: true,
  },
];

// Health endpoints the gateway aggregates, for a single "is the system up?"
// answer rather than seven separate curls.
export const HEALTH_TARGETS = [
  { name: 'auth-service', url: env.AUTH_SERVICE_URL },
  { name: 'donation-service', url: env.DONATION_SERVICE_URL },
  { name: 'geocoding-service', url: env.GEOCODING_SERVICE_URL },
  { name: 'agent-location-service', url: env.LOCATION_SERVICE_URL },
  { name: 'assignment-engine', url: env.ENGINE_SERVICE_URL },
  { name: 'tracking-service', url: env.TRACKING_SERVICE_URL },
  { name: 'notification-service', url: env.NOTIFICATION_SERVICE_URL },
];
