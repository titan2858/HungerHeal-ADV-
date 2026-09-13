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
