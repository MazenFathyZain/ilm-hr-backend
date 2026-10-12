import { all, get, run } from '../db/index.js';
import { badRequest, conflict, notFound, unprocessable } from '../utils/errors.js';
import { distanceMeters } from '../utils/geo.js';
import { addDays, monthRange, timeToMinutes, zonedParts, zonedToUtcIso } from '../utils/time.js';
import { assertDate, assertNumber, assertTime, requireFields } from '../utils/validate.js';
import { scopeFilter } from './access.js';
import { holidaySet, isWorkingDay, workingDaysBetween } from './calendar.js';
import { assignedLocations } from './locations.js';
import { getSettings } from './settings.js';

const RECORD_SELECT = `
  SELECT a.*, u.name AS user_name, u.employee_code, u.team_id, t.name AS team_name,
         li.name AS check_in_location, lo.name AS check_out_location
  FROM attendance a
  JOIN users u ON u.id = a.user_id
  LEFT JOIN teams t ON t.id = u.team_id
  LEFT JOIN locations li ON li.id = a.check_in_location_id
  LEFT JOIN locations lo ON lo.id = a.check_out_location_id`;

function present(rec, tz) {
  if (!rec) return null;
  const local = (iso) => (iso ? zonedParts(new Date(iso), tz).time : null);
  const worked = rec.check_in_at && rec.check_out_at
    ? Math.max(0, Math.round((Date.parse(rec.check_out_at) - Date.parse(rec.check_in_at)) / 60000))
    : null;
  return {
    ...rec,
    check_in_time: local(rec.check_in_at),
    check_out_time: local(rec.check_out_at),
    is_late: rec.late_minutes > 0,
    worked_minutes: worked,
  };
}

export function lateMinutesFor(localMinutes, settings) {
  const start = timeToMinutes(settings.work_start);
  return localMinutes > start + Number(settings.late_grace_minutes) ? localMinutes - start : 0;
}

/**
 * Finds the nearest assigned location and whether the coordinates fall inside its radius.
 * Throws a descriptive 422 if the user has no locations or is outside all of them.
 */
function resolveLocation(userId, body) {
  requireFields(body, ['latitude', 'longitude']);
  // The app reports whether the OS flagged the position as coming from a mock-location provider.
  if (body.is_mocked === true) {
    throw unprocessable('Fake GPS location detected. Disable mock location apps and try again.', 'mock_location');
  }
  const lat = assertNumber(body.latitude, 'latitude', { min: -90, max: 90 });
  const lng = assertNumber(body.longitude, 'longitude', { min: -180, max: 180 });

  const locations = assignedLocations(userId);
  if (!locations.length) {
    throw unprocessable('You have no check-in locations assigned. Please contact your manager.', 'no_location_assigned');
  }
  const ranked = locations
    .map((l) => ({ ...l, distance: Math.round(distanceMeters(lat, lng, l.latitude, l.longitude)) }))
    .sort((a, b) => a.distance - b.distance);
  const inside = ranked.find((l) => l.distance <= l.radius_meters);
  if (!inside) {
    const nearest = ranked[0];
    throw unprocessable(
      `You are ${nearest.distance} m away from ${nearest.name}. Move within ${nearest.radius_meters} m to check in/out.`,
      'outside_location',
      { nearest_location: { id: nearest.id, name: nearest.name, distance_meters: nearest.distance, radius_meters: nearest.radius_meters } },
    );
  }
  return { location: inside, lat, lng };
}

export function todayStatus(userId) {
  const settings = getSettings();
  const now = zonedParts(new Date(), settings.timezone);
  const record = get(`${RECORD_SELECT} WHERE a.user_id = ? AND a.work_date = ?`, userId, now.date);
  return {
    date: now.date,
    server_time: now.time,
    work_start: settings.work_start,
    work_end: settings.work_end,
    is_working_day: isWorkingDay(now.date, settings, holidaySet(now.date, now.date)),
    record: present(record, settings.timezone),
    can_check_in: !record?.check_in_at,
    can_check_out: !!record?.check_in_at && !record?.check_out_at,
    locations: assignedLocations(userId),
  };
}

export function checkIn(userId, body) {
  const settings = getSettings();
  const now = new Date();
  const local = zonedParts(now, settings.timezone);
  const existing = get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', userId, local.date);
  if (existing?.check_in_at) throw conflict('You have already checked in today', 'already_checked_in');

  const { location, lat, lng } = resolveLocation(userId, body);
  const late = lateMinutesFor(local.minutes, settings);
  run(
    `INSERT INTO attendance (user_id, work_date, check_in_at, check_in_location_id, check_in_lat, check_in_lng, late_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, work_date) DO UPDATE SET check_in_at = excluded.check_in_at,
       check_in_location_id = excluded.check_in_location_id, check_in_lat = excluded.check_in_lat,
       check_in_lng = excluded.check_in_lng, late_minutes = excluded.late_minutes`,
    userId, local.date, now.toISOString(), location.id, lat, lng, late,
  );
  return todayStatus(userId);
}

export function checkOut(userId, body) {
  const settings = getSettings();
  const now = new Date();
  const local = zonedParts(now, settings.timezone);
  const existing = get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', userId, local.date);
  if (!existing?.check_in_at) throw conflict('You have not checked in today', 'not_checked_in');
  if (existing.check_out_at) throw conflict('You have already checked out today', 'already_checked_out');

  const { location, lat, lng } = resolveLocation(userId, body);
  run(
    'UPDATE attendance SET check_out_at = ?, check_out_location_id = ?, check_out_lat = ?, check_out_lng = ? WHERE id = ?',
    now.toISOString(), location.id, lat, lng, existing.id,
  );
  return todayStatus(userId);
}

/** Dates covered by approved leave or missions for a user in a range. */
function excusedDates(userId, from, to) {
  const rows = all(
    `SELECT type, start_date, end_date FROM requests
     WHERE user_id = ? AND status = 'approved' AND type IN ('leave','mission')
       AND start_date <= ? AND end_date >= ?`,
    userId, to, from,
  );
  const set = new Set();
  for (const r of rows) {
    for (let d = r.start_date > from ? r.start_date : from; d <= (r.end_date < to ? r.end_date : to); d = addDays(d, 1)) set.add(d);
  }
  return set;
}

export function monthSummary(userId, month) {
  const settings = getSettings();
  const { from, to } = monthRange(month);
  const user = get('SELECT hire_date, created_at FROM users WHERE id = ?', userId);
  const today = zonedParts(new Date(), settings.timezone).date;

  const records = all('SELECT * FROM attendance WHERE user_id = ? AND work_date BETWEEN ? AND ?', userId, from, to);
  const attended = new Set(records.filter((r) => r.check_in_at).map((r) => r.work_date));
  const excused = excusedDates(userId, from, to);

  // Absences are counted for finished working days only, starting from the hire date.
  const startedOn = user?.hire_date ?? user?.created_at?.slice(0, 10) ?? from;
  const countFrom = startedOn > from ? startedOn : from;
  const yesterday = addDays(today, -1);
  const countTo = yesterday < to ? yesterday : to;
  const workDays = workingDaysBetween(countFrom, countTo, settings);
  const absent = workDays.filter((d) => !attended.has(d) && !excused.has(d));

  const workedMinutes = records.reduce((sum, r) => (r.check_in_at && r.check_out_at
    ? sum + Math.max(0, (Date.parse(r.check_out_at) - Date.parse(r.check_in_at)) / 60000) : sum), 0);

  return {
    month,
    working_days: workingDaysBetween(from, to, settings).length,
    present_days: attended.size,
    late_days: records.filter((r) => r.late_minutes > 0).length,
    total_late_minutes: records.reduce((s, r) => s + r.late_minutes, 0),
    absent_days: absent.length,
    absent_dates: absent,
    excused_days: [...excused].filter((d) => workDays.includes(d)).length,
    worked_hours: Math.round(workedMinutes / 6) / 10,
  };
}

export function history(userId, month) {
  const settings = getSettings();
  const { from, to } = monthRange(month);
  const records = all(`${RECORD_SELECT} WHERE a.user_id = ? AND a.work_date BETWEEN ? AND ? ORDER BY a.work_date DESC`, userId, from, to);
  return { summary: monthSummary(userId, month), records: records.map((r) => present(r, settings.timezone)) };
}

// ---- Admin ----

export function listAttendance(viewer, { from, to, user_id, team_id, late_only } = {}) {
  const settings = getSettings();
  const today = zonedParts(new Date(), settings.timezone).date;
  from = from ? assertDate(from, 'from') : today;
  to = to ? assertDate(to, 'to') : from;
  const scope = scopeFilter(viewer, 'a.user_id');
  const where = [scope.sql, 'a.work_date BETWEEN ? AND ?'];
  const params = [...scope.params, from, to];
  if (user_id) { where.push('a.user_id = ?'); params.push(Number(user_id)); }
  if (team_id) { where.push('u.team_id = ?'); params.push(Number(team_id)); }
  if (late_only === 'true') where.push('a.late_minutes > 0');
  return all(`${RECORD_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.work_date DESC, u.name LIMIT 5000`, ...params)
    .map((r) => present(r, settings.timezone));
}

/** One row per (scoped, active) employee describing their status for a date. */
export function dailyBoard(viewer, date) {
  const settings = getSettings();
  const today = zonedParts(new Date(), settings.timezone);
  date = date ? assertDate(date, 'date') : today.date;
  const scope = scopeFilter(viewer, 'u.id');
  const users = all(
    `SELECT u.id, u.name, u.employee_code, u.job_title, u.team_id, t.name AS team_name
     FROM users u LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.is_active = 1 AND ${scope.sql} ORDER BY u.name`,
    ...scope.params,
  );
  const workingDay = isWorkingDay(date, settings, holidaySet(date, date));
  const recs = new Map(all(`${RECORD_SELECT} WHERE a.work_date = ?`, date).map((r) => [r.user_id, r]));
  const onLeave = new Set(all(
    `SELECT user_id FROM requests WHERE status = 'approved' AND type IN ('leave','mission') AND start_date <= ? AND end_date >= ?`,
    date, date,
  ).map((r) => r.user_id));
  // Someone counts as absent once the grace period of that working day has passed without a check-in.
  const graceOver = date < today.date ||
    (date === today.date && today.minutes > timeToMinutes(settings.work_start) + Number(settings.late_grace_minutes));

  const rows = users.map((u) => {
    const rec = present(recs.get(u.id), settings.timezone);
    let status;
    if (rec?.check_in_at) status = rec.late_minutes > 0 ? 'late' : 'present';
    else if (onLeave.has(u.id)) status = 'on_leave';
    else if (!workingDay) status = 'day_off';
    else status = graceOver ? 'absent' : 'not_yet';
    return { ...u, status, record: rec };
  });
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  return { date, is_working_day: workingDay, counts, rows };
}

/** Manual correction by a manager. Times are wall-clock HH:MM in the company time zone. */
export function upsertRecord(actor, body) {
  requireFields(body, ['user_id', 'work_date']);
  const settings = getSettings();
  const userId = Number(body.user_id);
  if (!get('SELECT 1 FROM users WHERE id = ?', userId)) throw notFound('Employee');
  const date = assertDate(body.work_date, 'work_date');
  const inTime = body.check_in_time ? assertTime(body.check_in_time, 'check_in_time') : null;
  const outTime = body.check_out_time ? assertTime(body.check_out_time, 'check_out_time') : null;
  if (!inTime && outTime) throw badRequest('check_in_time is required when check_out_time is set');
  if (inTime && outTime && outTime <= inTime) throw badRequest('check_out_time must be after check_in_time');

  if (!inTime) {
    run('DELETE FROM attendance WHERE user_id = ? AND work_date = ?', userId, date);
    return null;
  }
  const checkInAt = zonedToUtcIso(date, inTime, settings.timezone);
  const checkOutAt = outTime ? zonedToUtcIso(date, outTime, settings.timezone) : null;
  run(
    `INSERT INTO attendance (user_id, work_date, check_in_at, check_out_at, late_minutes, note, edited_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, work_date) DO UPDATE SET check_in_at = excluded.check_in_at, check_out_at = excluded.check_out_at,
       late_minutes = excluded.late_minutes, note = excluded.note, edited_by = excluded.edited_by`,
    userId, date, checkInAt, checkOutAt, lateMinutesFor(timeToMinutes(inTime), settings), body.note ?? null, actor.id,
  );
  return present(get(`${RECORD_SELECT} WHERE a.user_id = ? AND a.work_date = ?`, userId, date), settings.timezone);
}
