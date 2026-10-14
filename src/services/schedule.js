// Working schedule per employee. Each field on the user row overrides the company default from settings
// when it is set (NULL = use the company setting):
//   work_start / work_end ('HH:MM'), late_grace_minutes, weekend_days (JSON list, 0 = Sunday … 6 = Saturday).
import { get } from '../db/index.js';
import { badRequest } from '../utils/errors.js';
import { assertNumber, assertTime } from '../utils/validate.js';
import { getSettings } from './settings.js';

export const SCHEDULE_FIELDS = ['work_start', 'work_end', 'late_grace_minutes', 'weekend_days'];

const parseDays = (v) => {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return null; }
};

/** Company settings with the employee's own schedule applied on top. */
export function applySchedule(settings, row) {
  const days = parseDays(row?.weekend_days);
  return {
    ...settings,
    work_start: row?.work_start || settings.work_start,
    work_end: row?.work_end || settings.work_end,
    late_grace_minutes: row?.late_grace_minutes ?? settings.late_grace_minutes,
    weekend_days: days ?? settings.weekend_days,
  };
}

export async function employeeSettings(userId) {
  const settings = await getSettings();
  const row = await get('SELECT work_start, work_end, late_grace_minutes, weekend_days FROM users WHERE id = ?', userId);
  return applySchedule(settings, row);
}

/** The schedule as shown to clients: effective values plus which ones are the employee's own. */
export function presentSchedule(row, settings) {
  const effective = applySchedule(settings, row);
  const own = {
    work_start: row.work_start || null,
    work_end: row.work_end || null,
    late_grace_minutes: row.late_grace_minutes ?? null,
    weekend_days: parseDays(row.weekend_days),
  };
  return {
    work_start: effective.work_start,
    work_end: effective.work_end,
    late_grace_minutes: Number(effective.late_grace_minutes),
    weekend_days: effective.weekend_days,
    custom: Object.values(own).some((v) => v != null),
    own,
  };
}

/** Validates schedule fields from an employee update. Empty string / null resets a field to the company default. */
export function cleanSchedule(input) {
  const out = {};
  for (const k of SCHEDULE_FIELDS) {
    if (input[k] === undefined) continue;
    const v = input[k];
    if (v === null || v === '') { out[k] = null; continue; }
    if (k === 'work_start' || k === 'work_end') out[k] = assertTime(v, k);
    else if (k === 'late_grace_minutes') out[k] = Math.round(assertNumber(v, k, { min: 0, max: 240 }));
    else {
      if (!Array.isArray(v) || v.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw badRequest('weekend_days must be a list of numbers 0-6');
      out[k] = JSON.stringify([...new Set(v)].sort());
    }
  }
  const start = out.work_start ?? input.work_start;
  const end = out.work_end ?? input.work_end;
  if (start && end && end <= start) throw badRequest('work_end must be after work_start');
  return out;
}
