import fs from 'node:fs';
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
  // Multer has already written uploads to disk by the time any later middleware
  // runs, and a validation failure jumps straight here without passing through
  // the controller. This is the one funnel every failure goes through, so it is
  // the only place cleanup is guaranteed - otherwise the upload directory fills
  // with images belonging to donations that were never created.
  if (Array.isArray(req.files) && req.files.length > 0) {
    for (const file of req.files) {
      fs.promises.unlink(file.path).catch(() => {});
    }
  }

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'something went wrong';
  let details;

  if (err instanceof ApiError) {
    ({ status, code, message, details } = err);
  } else if (err?.code === 11000) {
    // Mongo duplicate-key on a unique index.
    status = 409;
    code = 'CONFLICT';
    message = 'that record already exists';
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
