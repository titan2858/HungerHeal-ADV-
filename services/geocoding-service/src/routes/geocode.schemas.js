import { z } from 'zod';

export const geocodeQuerySchema = z.object({
  address: z
    .string()
    .trim()
    .min(3, 'address must be at least 3 characters')
    .max(500, 'address must be at most 500 characters'),
});

export const reverseQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});
