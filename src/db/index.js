import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  leader_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY,
  employee_code        TEXT UNIQUE,
  name                 TEXT NOT NULL,
  email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,
  national_id          TEXT,
  phone                TEXT,
  job_title            TEXT,
  branch               TEXT,
  role                 TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('manager','team_leader','employee')),
  team_id              INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  hire_date            TEXT,
  basic_salary         REAL NOT NULL DEFAULT 0,
  annual_leave_balance INTEGER NOT NULL DEFAULT 21,
  casual_leave_balance INTEGER NOT NULL DEFAULT 7,
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  address       TEXT,
  latitude      REAL NOT NULL,
  longitude     REAL NOT NULL,
  radius_meters INTEGER NOT NULL DEFAULT 100,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_locations (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id                    INTEGER PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date             TEXT NOT NULL,
  check_in_at           TEXT,
  check_in_location_id  INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  check_in_lat          REAL,
  check_in_lng          REAL,
  check_out_at          TEXT,
  check_out_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  check_out_lat         REAL,
  check_out_lng         REAL,
  late_minutes          INTEGER NOT NULL DEFAULT 0,
  note                  TEXT,
  edited_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(work_date);

CREATE TABLE IF NOT EXISTS requests (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('leave','allowance','mission','early_leave','overtime','complaint')),
  leave_type  TEXT CHECK (leave_type IN ('annual','casual','sick','unpaid')),
  start_date  TEXT,
  end_date    TEXT,
  days        INTEGER,
  start_time  TEXT,
  end_time    TEXT,
  hours       REAL,
  amount      REAL,
  destination TEXT,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  review_note TEXT,
  reviewed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id, status);

CREATE TABLE IF NOT EXISTS adjustments (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('penalty','reward')),
  amount     REAL NOT NULL DEFAULT 0,
  reason     TEXT NOT NULL,
  date       TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payslips (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month            TEXT NOT NULL,
  basic_salary     REAL NOT NULL DEFAULT 0,
  earnings         TEXT NOT NULL DEFAULT '{}',
  deductions       TEXT NOT NULL DEFAULT '{}',
  total_earnings   REAL NOT NULL DEFAULT 0,
  total_deductions REAL NOT NULL DEFAULT 0,
  net_salary       REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, month)
);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('missing','submitted','approved','rejected')),
  file_path     TEXT,
  original_name TEXT,
  mime_type     TEXT,
  note          TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, title)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
`;

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
};

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  database.exec(SCHEMA);
  const insert = database.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, JSON.stringify(value));
  return database;
}

export const db = open(config.dbFile);

// node:sqlite rejects `undefined` and booleans as parameters; normalise them.
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
const normArgs = (args) =>
  args.map((a) => (a && typeof a === 'object' && !Array.isArray(a)
    ? Object.fromEntries(Object.entries(a).map(([k, v]) => [k, norm(v)]))
    : norm(a)));

const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
};

export const get = (sql, ...args) => stmt(sql).get(...normArgs(args));
export const all = (sql, ...args) => stmt(sql).all(...normArgs(args));
export const run = (sql, ...args) => stmt(sql).run(...normArgs(args));

let depth = 0;
/** Runs fn inside a transaction (nested calls join the outer one). */
export function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

/** Builds "a = :a, b = :b" for an UPDATE from the keys of a patch object. */
export function setClause(patch) {
  return Object.keys(patch).map((k) => `${k} = :${k}`).join(', ');
}
