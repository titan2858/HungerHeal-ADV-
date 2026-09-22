import { Router } from 'express';
import { z } from 'zod';
import { validateQuery } from '../middleware/validate.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { KIND } from '../domain/templates.js';
import { list, unreadCount, markRead, markAllRead } from '../controllers/notification.controller.js';

export const notificationRouter = Router();

const listQuerySchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  includeExpired: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  kind: z.enum(Object.values(KIND)).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

notificationRouter.use(requireAuth);

// Registered before /:id so "unread-count" is not read as an id.
notificationRouter.get('/unread-count', unreadCount);
notificationRouter.get('/', validateQuery(listQuerySchema), list);
notificationRouter.post('/read-all', markAllRead);
notificationRouter.patch('/:id/read', markRead);
