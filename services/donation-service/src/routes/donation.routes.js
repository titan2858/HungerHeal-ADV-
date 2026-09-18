import { Router } from 'express';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { uploadImages, handleUploadErrors } from '../middleware/upload.js';
import { createDonationSchema, listDonationsQuerySchema } from './donation.schemas.js';
import { createDonation, listDonations, getDonation } from '../controllers/donation.controller.js';

export const donationRouter = Router();

// Everything below requires a valid token.
donationRouter.use(requireAuth);

// POST /donations - donors only.
//
// Middleware order matters: multer must run BEFORE validation, because with a
// multipart request the text fields do not exist on req.body until multer has
// parsed the stream.
donationRouter.post(
  '/',
  requireRole('DONOR'),
  uploadImages,
  handleUploadErrors,
  validateBody(createDonationSchema),
  createDonation,
);

// GET /donations - donors see their own, agents see all (see the controller).
donationRouter.get('/', validateQuery(listDonationsQuerySchema), listDonations);

// GET /donations/:id
donationRouter.get('/:id', getDonation);
