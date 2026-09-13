import { z } from 'zod';
import { FOOD_CATEGORIES, VEHICLE_TYPES } from '../domain/categories.js';

const email = z.string().trim().toLowerCase().email('must be a valid email address');

// 8 characters with at least one letter and one digit. Deliberately modest:
// strong enough to stop "password"/"12345678", without the punctuation rules
// that push people toward writing passwords down.
const password = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(128, 'password must be at most 128 characters')
  .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), {
    message: 'password must contain at least one letter and one number',
  });

const phone = z
  .string()
  .trim()
  .regex(/^[+]?[\d\s-]{7,15}$/, 'must be a valid phone number');

const identityFields = {
  name: z.string().trim().min(2, 'name must be at least 2 characters').max(120),
  email,
  phone,
  password,
};

// What an agent declares at registration. These feed the category-compatibility
// term of the assignment scoring formula in Phase 5, which is why they are
// collected at signup rather than bolted on later.
const capabilities = z.object({
  vehicleType: z.enum(VEHICLE_TYPES),
  hasInsulatedTransport: z.boolean().default(false),
  hasRefrigeration: z.boolean().default(false),
  categoriesHandled: z
    .array(z.enum(FOOD_CATEGORIES))
    .min(1, 'select at least one food category you can handle')
    // A duplicated category in the request should not become a duplicated
    // entry in the database.
    .transform((v) => [...new Set(v)]),
});

// A discriminated union on `role` instead of one schema with optional fields.
// The payoff: an agent signing up without capabilities is rejected with a clear
// message, and a donor sending capabilities is told they do not belong - neither
// of which a "capabilities optional" schema could express.
export const signupSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('DONOR'), ...identityFields }).strict(),
  z.object({ role: z.literal('AGENT'), ...identityFields, capabilities }).strict(),
]);

export const loginSchema = z
  .object({
    email,
    // No strength rules on login - the stored password must be accepted as-is
    // even if the policy tightens later.
    password: z.string().min(1, 'password is required'),
  })
  .strict();
