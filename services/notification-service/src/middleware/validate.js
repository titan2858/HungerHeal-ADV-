import { ApiError } from '../utils/ApiError.js';

// Validates req.body against a zod schema BEFORE the controller runs, and
// replaces the body with the parsed result so defaults and coercions apply.
//
// Validating at the boundary means controllers can trust their input and stay
// free of defensive checks, and clients get one consistent 400 listing every
// bad field at once instead of failing one field per round trip.
export const validateBody = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.body);

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
    }));
    return next(ApiError.badRequest('request body failed validation', details));
  }

  req.body = result.data;
  next();
};

// Same idea for query strings. Kept separate from validateBody because req.query
// is a getter on newer Express versions and cannot always be reassigned, so the
// parsed result goes on req.validatedQuery instead.
export const validateQuery = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.query);

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(query)',
      message: issue.message,
    }));
    return next(ApiError.badRequest('query parameters failed validation', details));
  }

  req.validatedQuery = result.data;
  next();
};
