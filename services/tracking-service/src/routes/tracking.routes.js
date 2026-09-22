import { Router } from 'express';
import { z } from 'zod';
import { validateQuery } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { STATUS } from '../domain/statusMachine.js';
import {
  getTracking, listTracking, markCollected, summary,
} from '../controllers/tracking.controller.js';

export const trackingRouter = Router();

const listQuerySchema = z.object({
  status: z.enum(Object.values(STATUS)).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

trackingRouter.use(requireAuth);

// Order matters: the literal path must be registered before the :donationId
// parameter, or "stats" is read as a donation id.
trackingRouter.get('/stats/summary', summary);
trackingRouter.get('/', validateQuery(listQuerySchema), listTracking);
trackingRouter.get('/:donationId', getTracking);

// Only agents collect.
trackingRouter.post('/:donationId/collected', requireRole('AGENT'), markCollected);
