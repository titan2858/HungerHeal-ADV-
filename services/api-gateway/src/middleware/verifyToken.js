import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// THE POINT OF THE GATEWAY.
//
// The token is verified ONCE here, at the edge, and the decoded identity is
// forwarded downstream as headers. Every service still verifies independently
// today - defence in depth, and they must keep working if called directly -
// but this is where the pattern becomes visible: no service has to call
// auth-service to learn who the caller is, because a signed token IS the proof.
//
// That is the difference from a session id, which would need a lookup on every
// request and make auth-service a dependency of literally every operation in
// the system.
export function verifyToken(required) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      if (!required) return next();
      return unauthorized(res, req, 'missing Bearer token');
    }

    try {
      const payload = jwt.verify(token, env.JWT_SECRET, {
        issuer: 'hungerheal-auth',
        // Pinned. Without this an attacker can present a token signed with
        // "none", or an RS256 token verified against a public key as an HMAC
        // secret, and have it accepted.
        algorithms: ['HS256'],
      });

      req.user = {
        id: payload.sub,
        role: payload.role,
        email: payload.email,
        name: payload.name,
        phone: payload.phone,
      };
      return next();
    } catch (err) {
      if (!required) return next(); // let the service decide
      const message = err.name === 'TokenExpiredError' ? 'token expired' : 'invalid token';
      return unauthorized(res, req, message);
    }
  };
}

function unauthorized(res, req, message) {
  // The same error shape every service returns, so a client parses one format
  // whether the rejection came from the edge or from a service.
  res.status(401).json({
    error: { code: 'UNAUTHORIZED', message, traceId: req.traceId },
  });
}
