import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { signToken } from '../utils/jwt.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';

// A precomputed hash of a throwaway string, used to burn the same ~10 rounds of
// bcrypt when the email does not exist as when it does. Without it, "unknown
// email" returns noticeably faster than "wrong password", which leaks whether an
// address is registered even though both return the same 401.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export async function signup(req, res, next) {
  try {
    const { email, password, role, name, phone } = req.body;

    // Checked explicitly so the common case gets a clear 409 rather than
    // relying on the unique index to raise a driver error. The index still
    // backs this up for concurrent signups - see errorHandler's 11000 branch.
    if (await User.exists({ email })) {
      throw ApiError.conflict('email is already registered');
    }

    const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

    const user = await User.create({
      name,
      email,
      phone,
      role,
      passwordHash,
      // Only agents carry capabilities; a donor body cannot contain them
      // (the schema is .strict()), so this is simply absent for donors.
      ...(role === 'AGENT' ? { capabilities: req.body.capabilities } : {}),
    });

    req.log.info({ userId: user.id, role }, 'user registered');

    // Returning a token straight from signup means the client is logged in
    // immediately instead of having to POST /auth/login right after.
    res.status(201).json({ user: user.toJSON(), token: signToken(user) });
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    // passwordHash is select:false on the schema, so it must be asked for.
    const user = await User.findOne({ email }).select('+passwordHash');

    const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

    // One identical error for both "no such user" and "wrong password", so the
    // endpoint cannot be used to enumerate which emails are registered.
    if (!user || !matches) {
      req.log.warn({ email }, 'failed login attempt');
      throw ApiError.unauthorized('invalid email or password');
    }

    req.log.info({ userId: user.id, role: user.role }, 'user logged in');

    res.json({ user: user.toJSON(), token: signToken(user) });
  } catch (err) {
    next(err);
  }
}

export async function me(req, res, next) {
  try {
    // Read through to the database rather than trusting the token's copy: an
    // agent's rating and availability change over time, and a 7-day-old token
    // would otherwise report stale values.
    const user = await User.findById(req.user.id);

    if (!user) {
      throw ApiError.notFound('user no longer exists');
    }

    res.json({ user: user.toJSON() });
  } catch (err) {
    next(err);
  }
}
