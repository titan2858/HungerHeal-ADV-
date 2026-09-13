import { Router } from 'express';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { signupSchema, loginSchema } from './auth.schemas.js';
import { signup, login, me } from '../controllers/auth.controller.js';

export const authRouter = Router();

// POST /auth/signup - donor or agent, discriminated by the `role` field
authRouter.post('/signup', validateBody(signupSchema), signup);

// POST /auth/login - returns a JWT
authRouter.post('/login', validateBody(loginSchema), login);

// GET /auth/me - the caller's own record, read fresh from the database
authRouter.get('/me', requireAuth, me);
