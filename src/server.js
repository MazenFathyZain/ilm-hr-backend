import { config } from './config.js';
import { createApp } from './app.js';
import { get } from './db/index.js';
import { seed } from './db/seed.js';

if (get('SELECT COUNT(*) AS n FROM users').n === 0) {
  seed();
  console.log('Empty database: demo data seeded (see README for logins).');
}

createApp().listen(config.port, () => {
  console.log(`HR API listening on http://localhost:${config.port}  (mobile: /api/mobile, dashboard: /api/admin)`);
});
