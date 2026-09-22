import { Router } from 'express';
import { z } from 'zod';
import { validateQuery } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { STATUS } from '../domain/statusMachine.js';
import { listDonations, donationDetail, systemStats } from '../controllers/monitoring.controller.js';

export const monitoringRouter = Router();

const listQuerySchema = z.object({
  status: z.enum(Object.values(STATUS)).optional(),
  unmatched: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

// ADMIN only, and every route here is a GET.
//
// The plan is explicit that any monitoring view is strictly read-only: it shows
// what the algorithm decided and why, with no assign or reassign controls. The
// absence of a write route in this file is the design, not an omission.
monitoringRouter.use(requireAuth, requireRole('ADMIN'));

monitoringRouter.get('/stats', systemStats);
monitoringRouter.get('/donations', validateQuery(listQuerySchema), listDonations);
monitoringRouter.get('/donations/:donationId', donationDetail);
