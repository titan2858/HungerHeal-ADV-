import { verifyToken } from '../utils/jwt.js';
import { ApiError } from '../utils/ApiError.js';

// Extracts and verifies the bearer token, attaching req.user = { id, role, email }.
//
// Note there is no database lookup here: the token is signed, so its contents
// are trustworthy without one. That is deliberate - it keeps auth a local,
// constant-time operation rather than a query on every single request.
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(ApiError.unauthorized('missing Bearer token'));
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, role: payload.role, email: payload.email };
    return next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'token expired' : 'invalid token';
    return next(ApiError.unauthorized(message));
  }
}

// Route guard for later phases: only agents may push locations, only donors may
// create donations, and so on.
export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!roles.includes(req.user.role)) {
    return next(ApiError.forbidden(`requires role: ${roles.join(' or ')}`));
  }
  next();
};
