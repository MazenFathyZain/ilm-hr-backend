// Creates the database (if the user may) and all tables. Safe to run repeatedly; it never deletes data.
//   npm run migrate
import { config } from '../config.js';
import { closeDb, get, initDb } from './index.js';

try {
  await initDb();
  const { n } = await get('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', config.db.name);
  console.log(`Database "${config.db.name}" on ${config.db.host}:${config.db.port} is up to date (${n} tables).`);
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
