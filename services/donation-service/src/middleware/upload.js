import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

export const uploadDir = path.resolve(process.cwd(), env.UPLOAD_DIR);
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    // NEVER build a filename from the client's. A name like "../../etc/passwd"
    // or a second extension ("x.png.js") is an attack, and two donors uploading
    // "photo.jpg" would collide. A random id plus a whitelisted extension
    // removes all three problems at once.
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, `${Date.now()}-${randomUUID()}${ext}`);
  },
});

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export const uploadImages = multer({
  storage,
  limits: {
    fileSize: env.MAX_IMAGE_BYTES,
    files: env.MAX_IMAGES_PER_DONATION,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      // Note this is the CLIENT-declared mime type, so it is a usability guard,
      // not a security boundary - a real check would sniff the file's magic
      // bytes. It is sufficient here because uploads are only ever served as
      // static files, never executed.
      return cb(ApiError.badRequest(`unsupported image type: ${file.mimetype}`));
    }
    cb(null, true);
  },
}).array('images', env.MAX_IMAGES_PER_DONATION);

// Multer reports its own limit violations through a MulterError with a code;
// translating them here keeps the error shape identical to every other endpoint.
export function handleUploadErrors(err, _req, _res, next) {
  if (err instanceof multer.MulterError) {
    const map = {
      LIMIT_FILE_SIZE: `image exceeds the ${Math.round(env.MAX_IMAGE_BYTES / 1024 / 1024)}MB limit`,
      LIMIT_FILE_COUNT: `at most ${env.MAX_IMAGES_PER_DONATION} images per donation`,
      LIMIT_UNEXPECTED_FILE: 'images must be sent in the "images" field',
    };
    return next(ApiError.badRequest(map[err.code] ?? `upload failed: ${err.code}`));
  }
  next(err);
}
