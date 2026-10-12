import { all } from '../db/index.js';
import { eachDay, weekday } from '../utils/time.js';

export async function holidaySet(from, to) {
  return new Set((await all('SELECT date FROM holidays WHERE date BETWEEN ? AND ?', from, to)).map((h) => h.date));
}

export function isWorkingDay(date, settings, holidays) {
  return !settings.weekend_days.includes(weekday(date)) && !holidays.has(date);
}

/** Working days (excluding weekends and holidays) between two dates, inclusive. */
export async function workingDaysBetween(from, to, settings) {
  if (!from || !to || to < from) return [];
  const holidays = await holidaySet(from, to);
  return [...eachDay(from, to)].filter((d) => isWorkingDay(d, settings, holidays));
}
