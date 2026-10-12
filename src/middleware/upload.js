import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { badRequest } from '../utils/errors.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

export const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    ALLOWED.includes(file.mimetype) ? cb(null, true) : cb(badRequest('Only PDF and image files are allowed')),
});
