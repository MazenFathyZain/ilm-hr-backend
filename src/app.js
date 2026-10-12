import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import adminRoutes from './routes/admin.js';
import mobileRoutes from './routes/mobile.js';
import { HttpError } from './utils/errors.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ status: 200, message: 'OK' }));
  app.use('/api/mobile', mobileRoutes);
  app.use('/api/admin', adminRoutes);

  app.use((_req, res) => res.status(404).json({ status: 404, message: 'Endpoint not found', code: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ status: err.status, message: err.message, code: err.code, ...(err.data && { data: err.data }) });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ status: 400, message: err.message, code: 'upload_error' });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ status: 400, message: 'Malformed JSON body', code: 'bad_request' });
    }
    console.error(err);
    res.status(500).json({ status: 500, message: 'Internal server error', code: 'internal_error' });
  });
  return app;
}
