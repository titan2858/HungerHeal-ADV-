import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// The JWT is the contract between auth-service and every other service.
//
// Why this matters architecturally: api-gateway (Phase 12) verifies this token
// ONCE at the edge using the same secret, then forwards the decoded identity
// downstream. No other service needs to call auth-service to learn who the
// caller is - that is the entire point of a signed token over a session lookup.
//
// Keep the payload small and stable: anything put here is duplicated into every
// request and cannot be revoked until the token expires.
export function signToken(user) {
  return jwt.sign(
    {
      sub: user.id ?? user._id.toString(),
      role: user.role,
      email: user.email,
      // name and phone ride along because donation-service snapshots the donor's
      // contact details onto every donation - an agent needs someone to call on
      // arrival. Carrying them in the token means creating a donation never has
      // to call back into auth-service, so a donation can still be submitted
      // while auth-service is down.
      //
      // The tradeoff: a user who changes their phone number keeps issuing the
      // old one until their token expires. Acceptable for contact details that
      // are snapshotted per donation anyway; it would NOT be acceptable for
      // anything security-relevant like role.
      name: user.name,
      phone: user.phone,
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN, issuer: 'hungerheal-auth' },
  );
}

// Throws on an expired, tampered or wrongly-issued token. Callers translate
// that into a 401.
export function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET, { issuer: 'hungerheal-auth' });
}
