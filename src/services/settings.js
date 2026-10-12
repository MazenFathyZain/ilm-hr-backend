import { all, get, run, tx } from '../db/index.js';
import { DEFAULT_SETTINGS } from '../db/index.js';
import { badRequest } from '../utils/errors.js';
import { assertDate, assertNumber, assertTime } from '../utils/validate.js';

export async function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of await all('SELECT `key`, value FROM settings')) out[row.key] = JSON.parse(row.value);
  return out;
}

const VALIDATORS = {
  company_name: (v) => { if (typeof v !== 'string' || !v.trim()) throw badRequest('company_name is required'); return v.trim(); },
  timezone: (v) => {
    try { new Intl.DateTimeFormat('en', { timeZone: v }); } catch { throw badRequest('timezone is not a valid IANA time zone'); }
    return v;
  },
  work_start: (v) => assertTime(v, 'work_start'),
  work_end: (v) => assertTime(v, 'work_end'),
  late_grace_minutes: (v) => assertNumber(v, 'late_grace_minutes', { min: 0, max: 240 }),
  weekend_days: (v) => {
    if (!Array.isArray(v) || v.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw badRequest('weekend_days must be a list of numbers 0-6');
    return [...new Set(v)].sort();
  },
  default_annual_leave: (v) => assertNumber(v, 'default_annual_leave', { min: 0, max: 365 }),
  default_casual_leave: (v) => assertNumber(v, 'default_casual_leave', { min: 0, max: 365 }),
  required_documents: (v) => {
    if (!Array.isArray(v) || v.some((d) => typeof d !== 'string' || !d.trim())) throw badRequest('required_documents must be a list of names');
    return [...new Set(v.map((d) => d.trim()))];
  },
  currency: (v) => { if (typeof v !== 'string' || !v.trim()) throw badRequest('currency is required'); return v.trim(); },
};

export async function updateSettings(patch) {
  const clean = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!VALIDATORS[key]) throw badRequest(`Unknown setting: ${key}`);
    clean[key] = VALIDATORS[key](value);
  }
  await tx(async () => {
    for (const [key, value] of Object.entries(clean)) {
      await run('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', key, JSON.stringify(value));
    }
  });
  return getSettings();
}

export const listHolidays = (year) =>
  year ? all("SELECT * FROM holidays WHERE date LIKE ? ORDER BY date", `${year}-%`) : all('SELECT * FROM holidays ORDER BY date');

export async function upsertHoliday({ date, name }) {
  assertDate(date, 'date');
  if (!name?.trim()) throw badRequest('name is required');
  await run('INSERT INTO holidays (date, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', date, name.trim());
  return get('SELECT * FROM holidays WHERE date = ?', date);
}

export const deleteHoliday = (date) => run('DELETE FROM holidays WHERE date = ?', date);
