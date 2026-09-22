import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import {
  donationHistory, daily, matching, agentTotals, recent,
} from '../controllers/analytics.controller.js';

export const analyticsRouter = Router();

// ADMIN only, and read-only - the same rule as the monitoring view. This
// service stores history; it has no opinion about what should happen next.
analyticsRouter.use(requireAuth, requireRole('ADMIN'));

analyticsRouter.get('/daily', daily);
analyticsRouter.get('/matching', matching);
analyticsRouter.get('/recent', recent);
analyticsRouter.get('/agents/:agentId', agentTotals);
analyticsRouter.get('/donations/:donationId', donationHistory);
