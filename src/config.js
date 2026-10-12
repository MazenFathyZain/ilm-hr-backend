import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    name: process.env.DB_NAME ?? 'ilm_hr',
    connectionLimit: Number(process.env.DB_POOL_SIZE ?? 10),
  },
  // Only used by `npm run migrate:sqlite` to import data from the previous SQLite version.
  sqliteFile: process.env.SQLITE_FILE ?? path.join(root, 'data', 'hr.sqlite'),
  uploadDir: process.env.UPLOAD_DIR ?? path.join(root, 'uploads'),
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  isProduction: process.env.NODE_ENV === 'production',
};

if (config.isProduction && config.jwtSecret === 'dev-only-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}
