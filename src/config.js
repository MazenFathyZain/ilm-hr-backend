import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
  dbFile: process.env.DB_FILE ?? path.join(root, 'data', 'hr.sqlite'),
  uploadDir: process.env.UPLOAD_DIR ?? path.join(root, 'uploads'),
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  isProduction: process.env.NODE_ENV === 'production',
};

if (config.isProduction && config.jwtSecret === 'dev-only-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}
