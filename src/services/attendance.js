import { all, get, run, tx } from '../db/index.js';
import { badRequest, conflict, notFound, unprocessable } from '../utils/errors.js';
import { distanceMeters } from '../utils/geo.js';
import { addDays, monthRange, timeToMinutes, zonedParts, zonedToUtcIso } from '../utils/time.js';
import { assertDate, assertNumber, assertTime, requireFields } from '../utils/validate.js';
import { avatarUrl } from '../utils/files.js';
import { scopeFilter } from './access.js';
import { holidaySet, isWorkingDay, workingDaysBetween } from './calendar.js';
import { assignedLocations } from './locations.js';
import { notify } from './notifications.js';
import { applySchedule, employeeSettings } from './schedule.js';
import { getSettings } from './settings.js';

const RECORD_SELECT = `
  SELECT a.*, u.name AS user_name, u.employee_code, u.team_id, u.avatar_path, t.name AS team_name,
         li.name AS check_in_location, lo.name AS check_out_location,
         (SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, b.left_at, b.returned_at)), 0)
            FROM attendance_breaks b WHERE b.attendance_id = a.id AND b.returned_at IS NOT NULL) AS away_seconds
  FROM attendance a
  JOIN users u ON u.id = a.user_id
  LEFT JOIN teams t ON t.id = u.team_id
  LEFT JOIN locations li ON li.id = a.check_in_location_id
  LEFT JOIN locations lo ON lo.id = a.check_out_location_id`;

function present(rec, tz) {
  if (!rec) return null;
  const local = (iso) => (iso ? zonedParts(new Date(iso), tz).time : null);
  const away = Math.round(Number(rec.away_seconds ?? 0) / 60);
  const worked = rec.check_in_at && rec.check_out_at
    ? Math.max(0, Math.round((Date.parse(rec.check_out_at) - Date.parse(rec.check_in_at)) / 60000) - away)
    : null;
  const { avatar_path: avatarPath, away_seconds: _away, ...rest } = rec;
  return {
    ...rest,
    user_avatar_url: avatarUrl(avatarPath),
    check_in_time: local(rec.check_in_at),
    check_out_time: local(rec.check_out_at),
    is_late: rec.late_minutes > 0,
    left_location: rec.check_out_method === 'left_location',
    away_minutes: away,
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
async function resolveLocation(userId, body) {
  requireFields(body, ['latitude', 'longitude']);
  // The app reports whether the OS flagged the position as coming from a mock-location provider.
  if (body.is_mocked === true) {
    throw unprocessable('Fake GPS location detected. Disable mock location apps and try again.', 'mock_location');
  }
  const lat = assertNumber(body.latitude, 'latitude', { min: -90, max: 90 });
  const lng = assertNumber(body.longitude, 'longitude', { min: -180, max: 180 });

  const locations = await assignedLocations(userId);
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

export async function todayStatus(userId) {
  const settings = await employeeSettings(userId);
  const now = zonedParts(new Date(), settings.timezone);
  const record = await get(`${RECORD_SELECT} WHERE a.user_id = ? AND a.work_date = ?`, userId, now.date);
  return {
    date: now.date,
    server_time: now.time,
    work_start: settings.work_start,
    work_end: settings.work_end,
    is_working_day: isWorkingDay(now.date, settings, await holidaySet(now.date, now.date)),
    record: present(record, settings.timezone),
    // After an automatic check-out (left the location) the employee may check in again when back.
    can_check_in: !record?.check_in_at || record.check_out_method === 'left_location',
    can_check_out: !!record?.check_in_at && !record?.check_out_at,
    checked_out_automatically: record?.check_out_method === 'left_location',
    auto_checkout_on_leave: settings.auto_checkout_on_leave,
    locations: await assignedLocations(userId),
  };
}

export async function checkIn(userId, body) {
  const settings = await employeeSettings(userId);
  const now = new Date();
  const local = zonedParts(now, settings.timezone);
  const existing = await get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', userId, local.date);
  const returning = existing?.check_in_at && existing.check_out_method === 'left_location';
  if (existing?.check_in_at && !returning) throw conflict('You have already checked in today', 'already_checked_in');

  const { location, lat, lng } = await resolveLocation(userId, body);
  if (returning) {
    // Back after leaving: reopen the day and close the break.
    await tx(async () => {
      await run(
        'UPDATE attendance SET check_out_at = NULL, check_out_location_id = NULL, check_out_lat = NULL, check_out_lng = NULL, check_out_method = NULL, last_ping_at = ? WHERE id = ?',
        now.toISOString(), existing.id,
      );
      await run('UPDATE attendance_breaks SET returned_at = ? WHERE attendance_id = ? AND returned_at IS NULL', now.toISOString(), existing.id);
    });
    return todayStatus(userId);
  }
  const late = lateMinutesFor(local.minutes, settings);
  await run(
    `INSERT INTO attendance (user_id, work_date, check_in_at, check_in_location_id, check_in_lat, check_in_lng, late_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE check_in_at = VALUES(check_in_at),
       check_in_location_id = VALUES(check_in_location_id), check_in_lat = VALUES(check_in_lat),
       check_in_lng = VALUES(check_in_lng), late_minutes = VALUES(late_minutes)`,
    userId, local.date, now.toISOString(), location.id, lat, lng, late,
  );
  return todayStatus(userId);
}

export async function checkOut(userId, body) {
  const settings = await getSettings();
  const now = new Date();
  const local = zonedParts(now, settings.timezone);
  const existing = await get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', userId, local.date);
  if (!existing?.check_in_at) throw conflict('You have not checked in today', 'not_checked_in');
  if (existing.check_out_at) throw conflict('You have already checked out today', 'already_checked_out');

  const { location, lat, lng } = await resolveLocation(userId, body);
  await run(
    "UPDATE attendance SET check_out_at = ?, check_out_location_id = ?, check_out_lat = ?, check_out_lng = ?, check_out_method = 'manual' WHERE id = ?",
    now.toISOString(), location.id, lat, lng, existing.id,
  );
  return todayStatus(userId);
}

/**
 * Called by the app while the employee is checked in. If the reported position is clearly outside every
 * assigned location (distance minus GPS accuracy is still beyond the radius), the employee is checked out
 * automatically at that moment and a break is opened; checking in again on return closes it.
 */
const STALE_PING_MS = 5 * 60 * 1000;

export async function locationPing(userId, body) {
  const settings = await getSettings();
  if (!settings.auto_checkout_on_leave) return { tracking: false };
  requireFields(body, ['latitude', 'longitude']);
  const lat = assertNumber(body.latitude, 'latitude', { min: -90, max: 90 });
  const lng = assertNumber(body.longitude, 'longitude', { min: -180, max: 180 });
  // Poor fixes are not trusted: the uncertainty is capped so a wild reading can't hide a real departure forever.
  const accuracy = Math.min(Math.max(Number(body.accuracy) || 0, 0), 100);

  const now = new Date();
  const local = zonedParts(now, settings.timezone);
  const record = await get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', userId, local.date);
  if (!record?.check_in_at || record.check_out_at) return { tracking: true, checked_in: false };
  if (body.is_mocked === true) return { tracking: true, checked_in: true, ignored: 'mock_location' };

  const locations = await assignedLocations(userId);
  const ranked = locations
    .map((l) => ({ ...l, distance: Math.round(distanceMeters(lat, lng, l.latitude, l.longitude)) }))
    .sort((a, b) => a.distance - b.distance);
  const nearest = ranked[0];
  const clearlyOutside = !nearest || ranked.every((l) => l.distance - accuracy > l.radius_meters);

  if (!clearlyOutside) {
    await run('UPDATE attendance SET last_ping_at = ? WHERE id = ?', now.toISOString(), record.id);
    return { tracking: true, checked_in: true, inside: nearest.distance <= nearest.radius_meters, distance_meters: nearest.distance, location: nearest.name };
  }

  // If the app had not reported for a while (closed / no signal), the employee left some time after the last
  // position that was still inside: record that moment rather than "now", so worked time is not inflated.
  const lastInside = record.last_ping_at ? new Date(record.last_ping_at) : null;
  const leftAt = lastInside && now - lastInside > STALE_PING_MS ? lastInside : now;
  await tx(async () => {
    await run(
      "UPDATE attendance SET check_out_at = ?, check_out_lat = ?, check_out_lng = ?, check_out_method = 'left_location', last_ping_at = ? WHERE id = ? AND check_out_at IS NULL",
      leftAt.toISOString(), lat, lng, now.toISOString(), record.id,
    );
    await run('INSERT INTO attendance_breaks (attendance_id, left_at, left_lat, left_lng) VALUES (?, ?, ?, ?)', record.id, leftAt.toISOString(), lat, lng);
  });
  const leftLocal = zonedParts(leftAt, settings.timezone).time;
  await notify(userId, 'auto_checkout', { time: leftLocal, location: nearest?.name }, { attendance_id: record.id });
  const leader = await get(
    'SELECT t.leader_id, u.name FROM users u JOIN teams t ON t.id = u.team_id WHERE u.id = ? AND t.leader_id IS NOT NULL AND t.leader_id <> u.id',
    userId,
  );
  if (leader) await notify(leader.leader_id, 'team_member_left', { name: leader.name, time: leftLocal }, { user_id: userId });

  return { tracking: true, checked_in: false, auto_checked_out: true, status: await todayStatus(userId) };
}

/** Dates covered by approved leave or missions for a user in a range. */
async function excusedDates(userId, from, to) {
  const rows = await all(
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

export async function monthSummary(userId, month) {
  const settings = await employeeSettings(userId);
  const { from, to } = monthRange(month);
  const user = await get('SELECT hire_date, created_at FROM users WHERE id = ?', userId);
  const today = zonedParts(new Date(), settings.timezone).date;

  const records = await all('SELECT * FROM attendance WHERE user_id = ? AND work_date BETWEEN ? AND ?', userId, from, to);
  const attended = new Set(records.filter((r) => r.check_in_at).map((r) => r.work_date));
  const excused = await excusedDates(userId, from, to);

  // Absences are counted for finished working days only, starting from the hire date.
  const startedOn = user?.hire_date ?? user?.created_at?.slice(0, 10) ?? from;
  const countFrom = startedOn > from ? startedOn : from;
  const yesterday = addDays(today, -1);
  const countTo = yesterday < to ? yesterday : to;
  const workDays = await workingDaysBetween(countFrom, countTo, settings);
  const absent = workDays.filter((d) => !attended.has(d) && !excused.has(d));

  const workedMinutes = records.reduce((sum, r) => (r.check_in_at && r.check_out_at
    ? sum + Math.max(0, (Date.parse(r.check_out_at) - Date.parse(r.check_in_at)) / 60000) : sum), 0);

  return {
    month,
    working_days: (await workingDaysBetween(from, to, settings)).length,
    present_days: attended.size,
    late_days: records.filter((r) => r.late_minutes > 0).length,
    total_late_minutes: records.reduce((s, r) => s + r.late_minutes, 0),
    absent_days: absent.length,
    absent_dates: absent,
    excused_days: [...excused].filter((d) => workDays.includes(d)).length,
    worked_hours: Math.round(workedMinutes / 6) / 10,
  };
}

export async function history(userId, month) {
  const settings = await getSettings();
  const { from, to } = monthRange(month);
  const records = await all(`${RECORD_SELECT} WHERE a.user_id = ? AND a.work_date BETWEEN ? AND ? ORDER BY a.work_date DESC`, userId, from, to);
  return { summary: await monthSummary(userId, month), records: records.map((r) => present(r, settings.timezone)) };
}

// ---- Admin ----

export async function listAttendance(viewer, { from, to, user_id, team_id, late_only } = {}) {
  const settings = await getSettings();
  const today = zonedParts(new Date(), settings.timezone).date;
  from = from ? assertDate(from, 'from') : today;
  to = to ? assertDate(to, 'to') : from;
  const scope = await scopeFilter(viewer, 'a.user_id');
  const where = [scope.sql, 'a.work_date BETWEEN ? AND ?'];
  const params = [...scope.params, from, to];
  if (user_id) { where.push('a.user_id = ?'); params.push(Number(user_id)); }
  if (team_id) { where.push('u.team_id = ?'); params.push(Number(team_id)); }
  if (late_only === 'true') where.push('a.late_minutes > 0');
  return (await all(`${RECORD_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.work_date DESC, u.name LIMIT 5000`, ...params))
    .map((r) => present(r, settings.timezone));
}

/** One row per (scoped, active) employee describing their status for a date. */
export async function dailyBoard(viewer, date) {
  const settings = await getSettings();
  const today = zonedParts(new Date(), settings.timezone);
  date = date ? assertDate(date, 'date') : today.date;
  const scope = await scopeFilter(viewer, 'u.id');
  const users = await all(
    `SELECT u.id, u.name, u.employee_code, u.job_title, u.team_id, u.avatar_path, t.name AS team_name,
            u.work_start, u.work_end, u.late_grace_minutes, u.weekend_days
     FROM users u LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.is_active = 1 AND ${scope.sql} ORDER BY u.name`,
    ...scope.params,
  );
  const holidays = await holidaySet(date, date);
  const recs = new Map((await all(`${RECORD_SELECT} WHERE a.work_date = ?`, date)).map((r) => [r.user_id, r]));
  const onLeave = new Set((await all(
    `SELECT user_id FROM requests WHERE status = 'approved' AND type IN ('leave','mission') AND start_date <= ? AND end_date >= ?`,
    date, date,
  )).map((r) => r.user_id));

  const rows = users.map((u) => {
    // Each employee's own working days and start time (company defaults when not set).
    const s = applySchedule(settings, u);
    const workingDay = isWorkingDay(date, s, holidays);
    // Absent once the grace period of that employee's working day has passed without a check-in.
    const graceOver = date < today.date ||
      (date === today.date && today.minutes > timeToMinutes(s.work_start) + Number(s.late_grace_minutes));
    const rec = present(recs.get(u.id), settings.timezone);
    let status;
    if (rec?.check_in_at) status = rec.late_minutes > 0 ? 'late' : 'present';
    else if (onLeave.has(u.id)) status = 'on_leave';
    else if (!workingDay) status = 'day_off';
    else status = graceOver ? 'absent' : 'not_yet';
    const { avatar_path: avatarPath, work_start: _ws, work_end: _we, late_grace_minutes: _lg, weekend_days: _wd, ...user } = u;
    return { ...user, avatar_url: avatarUrl(avatarPath), status, record: rec, work_start: s.work_start, work_end: s.work_end };
  });
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  const companyDay = isWorkingDay(date, settings, holidays);
  return { date, is_working_day: companyDay, counts, rows };
}

/** Manual correction by a manager. Times are wall-clock HH:MM in the company time zone. */
export async function upsertRecord(actor, body) {
  requireFields(body, ['user_id', 'work_date']);
  const userId = Number(body.user_id);
  const settings = await employeeSettings(userId);
  if (!(await get('SELECT 1 AS ok FROM users WHERE id = ?', userId))) throw notFound('Employee');
  const date = assertDate(body.work_date, 'work_date');
  const inTime = body.check_in_time ? assertTime(body.check_in_time, 'check_in_time') : null;
  const outTime = body.check_out_time ? assertTime(body.check_out_time, 'check_out_time') : null;
  if (!inTime && outTime) throw badRequest('check_in_time is required when check_out_time is set');
  if (inTime && outTime && outTime <= inTime) throw badRequest('check_out_time must be after check_in_time');

  if (!inTime) {
    await run('DELETE FROM attendance WHERE user_id = ? AND work_date = ?', userId, date);
    return null;
  }
  const checkInAt = zonedToUtcIso(date, inTime, settings.timezone);
  const checkOutAt = outTime ? zonedToUtcIso(date, outTime, settings.timezone) : null;
  await run(
    `INSERT INTO attendance (user_id, work_date, check_in_at, check_out_at, check_out_method, late_minutes, note, edited_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE check_in_at = VALUES(check_in_at), check_out_at = VALUES(check_out_at), check_out_method = VALUES(check_out_method),
       late_minutes = VALUES(late_minutes), note = VALUES(note), edited_by = VALUES(edited_by)`,
    userId, date, checkInAt, checkOutAt, checkOutAt ? 'admin' : null, lateMinutesFor(timeToMinutes(inTime), settings), body.note ?? null, actor.id,
  );
  return present(await get(`${RECORD_SELECT} WHERE a.user_id = ? AND a.work_date = ?`, userId, date), settings.timezone);
}
