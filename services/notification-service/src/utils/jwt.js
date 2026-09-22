import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// donation-service only VERIFIES tokens - it never issues them. Only
// auth-service signs.
//
// This is the payoff of using a signed token instead of a session id: to learn
// who the caller is, this service does a local signature check against the
// shared secret. It never calls auth-service, so auth-service being down does
// not stop donations from being created.
export function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET, { issuer: 'hungerheal-auth' });
}
