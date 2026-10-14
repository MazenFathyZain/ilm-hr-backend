import cors from 'cors';
import express from 'express';
import path from 'node:path';
import multer from 'multer';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { openApiSpec } from './docs/openapi.js';
import adminRoutes from './routes/admin.js';
import mobileRoutes from './routes/mobile.js';
import { localizeError, requestLang } from './utils/errorMessages.js';
import { HttpError } from './utils/errors.js';

/** Error envelope { status, message, code, data? } with the message in the caller's language (Accept-Language). */
function send(req, res, status, message, code, data) {
  res.status(status).json({ status, message: localizeError(message, status, requestLang(req)), code, ...(data && { data }) });
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ status: 200, message: 'OK' }));
  // Profile photos (random, unguessable file names) – public so <img>/Image.network can load them.
  app.use('/api/uploads/avatars', express.static(path.join(config.uploadDir, 'avatars'), { maxAge: '7d', index: false }));
  app.get('/api/docs.json', (_req, res) => res.json(openApiSpec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'Ilm HR API',
    swaggerOptions: { persistAuthorization: true, docExpansion: 'none', filter: true, tagsSorter: 'alpha' },
  }));
  app.use('/api/mobile', mobileRoutes);
  app.use('/api/admin', adminRoutes);

  app.use((req, res) => send(req, res, 404, 'Endpoint not found', 'not_found'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return send(req, res, err.status, err.message, err.code, err.data);
    if (err instanceof multer.MulterError) {
      return err.code === 'LIMIT_FILE_SIZE'
        ? send(req, res, 413, 'File too large', 'file_too_large')
        : send(req, res, 400, err.message, 'upload_error');
    }
    if (err.type === 'entity.parse.failed') return send(req, res, 400, 'Malformed JSON body', 'bad_request');
    console.error(err);
    send(req, res, 500, 'Internal server error', 'internal_error');
  });
  return app;
}
