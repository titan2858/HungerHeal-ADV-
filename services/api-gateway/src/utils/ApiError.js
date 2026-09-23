// A thrown error that already knows its HTTP status, so controllers can
// `throw new ApiError(409, ...)` and let one central handler do the responding.
// Without this, every controller grows its own res.status(...) branches and the
// error shape drifts between endpoints.
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    // Distinguishes errors we raised deliberately from genuine crashes.
    this.expected = true;
  }

  static badRequest(message, details) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'authentication required') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'not permitted') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'not found') {
    return new ApiError(404, 'NOT_FOUND', message);
  }
  static conflict(message, details) {
    return new ApiError(409, 'CONFLICT', message, details);
  }
}
