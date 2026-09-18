import { z } from 'zod';
import { FOOD_CATEGORIES, QUANTITY_UNITS, DONATION_STATUSES } from '../domain/categories.js';

// Multipart form fields arrive as STRINGS - "3" not 3, "12.97" not 12.97.
// z.coerce handles that, and keeps the same schema working for a plain JSON
// request body where the values are already numbers.
const coordinate = (min, max, label) =>
  z.coerce
    .number()
    .min(min, `${label} must be >= ${min}`)
    .max(max, `${label} must be <= ${max}`);

export const createDonationSchema = z
  .object({
    title: z.string().trim().min(3, 'title must be at least 3 characters').max(140),
    description: z.string().trim().max(2000).optional(),

    category: z.enum(FOOD_CATEGORIES, {
      errorMap: () => ({ message: `category must be one of: ${FOOD_CATEGORIES.join(', ')}` }),
    }),

    quantityAmount: z.coerce.number().positive('quantity must be greater than zero'),
    quantityUnit: z.enum(QUANTITY_UNITS),

    pickupAddress: z.string().trim().min(5, 'pickup address is too short').max(500),

    // Optional in Phase 2. Phase 3's geocoding-service derives them from the
    // address when the client does not supply them (the map picker will).
    lat: coordinate(-90, 90, 'lat').optional(),
    lng: coordinate(-180, 180, 'lng').optional(),

    bestBefore: z.coerce
      .date()
      .refine((d) => d.getTime() > Date.now(), 'bestBefore must be in the future'),
  })
  // Coordinates are meaningless alone - one without the other is a client bug
  // worth reporting rather than silently half-storing.
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: 'lat and lng must be provided together',
    path: ['lat'],
  });

// Query parameters are always strings, so every field here coerces.
export const listDonationsQuerySchema = z.object({
  status: z.enum(DONATION_STATUSES).optional(),
  category: z.enum(FOOD_CATEGORIES).optional(),
  // "only my donations" - what the donor dashboard uses.
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Skip-based paging is fine at this scale; a cursor would be the answer if
  // these lists ever got deep.
  offset: z.coerce.number().int().min(0).default(0),
});
