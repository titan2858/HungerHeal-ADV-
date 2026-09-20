import { Router } from 'express';
import { validateQuery } from '../middleware/validate.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { geocodeQuerySchema, reverseQuerySchema } from './geocode.schemas.js';
import { geocode, reverse, stats } from '../controllers/geocode.controller.js';

export const geocodeRouter = Router();

// Authenticated, because every uncached call spends real quota. An open
// endpoint here is a free way for anyone to burn the daily allowance.
geocodeRouter.use(requireAuth);

geocodeRouter.get('/geocode', validateQuery(geocodeQuerySchema), geocode);
geocodeRouter.get('/reverse', validateQuery(reverseQuerySchema), reverse);
geocodeRouter.get('/stats', stats);
