import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';

export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`no route for ${req.method} ${req.originalUrl}`));
}

// One place that turns any thrown error into an HTTP response, so the body
// shape is identical across every endpoint:
//   { error: { code, message, details?, traceId } }
// Returning the traceId lets a user report a failure and have it located in the
// logs immediately.
export function errorHandler(err, req, res, _next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'something went wrong';
  let details;

  if (err instanceof ApiError) {
    ({ status, code, message, details } = err);
  } else if (err?.code === 11000) {
    // Mongo duplicate-key. Reached when two signups for the same email race
    // past the pre-insert existence check - the unique index is the real
    // guarantee, this branch just reports it as a clean 409.
    status = 409;
    code = 'CONFLICT';
    message = 'email is already registered';
  } else if (err?.name === 'ValidationError') {
    status = 400;
    code = 'BAD_REQUEST';
    message = 'document failed validation';
    details = Object.values(err.errors ?? {}).map((e) => ({
      field: e.path,
      message: e.message,
    }));
  }

  const log = req.log ?? console;
  // 5xx is our bug and deserves a stack trace; 4xx is the caller's problem and
  // would only be log noise at error level.
  if (status >= 500) {
    log.error({ err: err.message, stack: err.stack, code }, 'unhandled error');
  } else {
    log.warn({ code, message, status }, 'request rejected');
  }

  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      traceId: req.traceId,
    },
  });
}
