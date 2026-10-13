import { AsyncLocalStorage } from 'node:async_hooks';
import mariadb from 'mariadb';
import { config } from '../config.js';
import { MIGRATIONS, SCHEMA } from './schema.js';

export const DEFAULT_SETTINGS = {
  company_name: 'علم لإحياء التراث والخدمات الرقمية',
  timezone: 'Africa/Cairo',
  work_start: '09:00',
  work_end: '17:00',
  late_grace_minutes: 15,
  // 0 = Sunday … 6 = Saturday. Friday and Saturday by default.
  weekend_days: [5, 6],
  default_annual_leave: 21,
  default_casual_leave: 7,
  required_documents: ['National ID copy', 'Birth certificate', 'Graduation certificate', 'Military status certificate', 'Criminal record', 'Personal photos'],
  currency: 'EGP',
  // Check the employee out automatically when the app reports they left all of their assigned locations.
  auto_checkout_on_leave: true,
};

// Return DATE columns as 'YYYY-MM-DD' and DATETIME columns as UTC ISO strings ('…Z'),
// which is what the services (and API clients) work with.
function typeCast(column, next) {
  if (column.type === 'DATE' || column.type === 'NEWDATE') return column.string();
  if (column.type === 'DATETIME' || column.type === 'TIMESTAMP' || column.type === 'DATETIME2' || column.type === 'TIMESTAMP2') {
    const s = column.string();
    if (!s) return null;
    const [d, t = '00:00:00'] = s.split(' ');
    const [hms, ms = '0'] = t.split('.');
    return `${d}T${hms}.${ms.padEnd(3, '0').slice(0, 3)}Z`;
  }
  return next();
}

const connectionOptions = {
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  charset: 'utf8mb4',
  // Plain JS numbers for COUNT/SUM/DECIMAL/insert ids (values in this app are well within 2^53).
  bigIntAsNumber: true,
  decimalAsNumber: true,
  insertIdAsNumber: true,
  // Store and read every timestamp in UTC; business rules convert to the company time zone.
  timezone: 'Z',
  initSql: "SET time_zone = '+00:00'",
  typeCast,
};

let pool = null;
const txStore = new AsyncLocalStorage();

/** Creates the database (if missing) and tables, then seeds default settings. */
export async function initDb() {
  if (pool) return;
  const bootstrap = await mariadb.createConnection({ ...connectionOptions });
  try {
    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await bootstrap.end();
  }
  pool = mariadb.createPool({ ...connectionOptions, database: config.db.name, connectionLimit: config.db.connectionLimit });

  for (const statement of SCHEMA) await pool.query(statement);
  for (const statement of MIGRATIONS) await pool.query(statement);
  const fk = await pool.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'users' AND CONSTRAINT_NAME = 'fk_users_team'`,
    [config.db.name],
  );
  if (!fk.length) {
    await pool.query('ALTER TABLE users ADD CONSTRAINT fk_users_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL');
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query('INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
  }
}

export async function closeDb() {
  if (pool) await pool.end();
  pool = null;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// Normalise parameters: undefined → NULL, booleans → 0/1, ISO UTC strings → DATETIME literals.
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && ISO_UTC.test(v)) return v.replace('T', ' ').replace('Z', '');
  return v;
}

async function query(sql, args) {
  if (!pool) throw new Error('Database not initialised – call initDb() first');
  const executor = txStore.getStore() ?? pool;
  const single = args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]);
  if (single) {
    // Named placeholders (`:name`) when a single object is passed.
    const named = Object.fromEntries(Object.entries(args[0]).map(([k, v]) => [k, norm(v)]));
    return executor.query({ sql, namedPlaceholders: true }, named);
  }
  return executor.query(sql, args.map(norm));
}

/** First row or undefined. */
export async function get(sql, ...args) {
  const rows = await query(sql, args);
  return rows[0];
}

/** All rows as plain objects. */
export async function all(sql, ...args) {
  return [...(await query(sql, args))];
}

/** INSERT / UPDATE / DELETE. Returns { lastInsertRowid, changes }. */
export async function run(sql, ...args) {
  const res = await query(sql, args);
  return { lastInsertRowid: Number(res.insertId ?? 0), changes: Number(res.affectedRows ?? 0) };
}

/** Runs fn inside a transaction; every query made inside it (even in nested calls) uses the same connection. */
export async function tx(fn) {
  if (txStore.getStore()) return fn();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await txStore.run(conn, fn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/** Builds "a = :a, b = :b" for an UPDATE from the keys of a patch object. */
export function setClause(patch) {
  return Object.keys(patch).map((k) => `${k} = :${k}`).join(', ');
}
