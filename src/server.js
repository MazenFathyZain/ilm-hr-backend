import { config } from './config.js';
import { createApp } from './app.js';
import { closeDb, initDb } from './db/index.js';
import { isEmpty, seed } from './db/seed.js';

await initDb();
if (await isEmpty()) {
  await seed();
  console.log('Empty database: demo data seeded (see README for logins).');
}

const server = createApp().listen(config.port, () => {
  console.log(`HR API listening on http://localhost:${config.port}  (mobile: /api/mobile, dashboard: /api/admin, docs: /api/docs)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => closeDb().finally(() => process.exit(0))));
}
