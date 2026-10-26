import { all, get } from '../db/index.js';
import { badRequest } from '../utils/errors.js';
import { addDays, zonedParts } from '../utils/time.js';
import { assertDate } from '../utils/validate.js';
import { scopeFilter } from './access.js';
import { dailyBoard, monthSummary, todayStatus } from './attendance.js';
import { holidaySet, isWorkingDay } from './calendar.js';
import { documentSummary } from './documents.js';
import { leaveBalances, listRequests, requestStats } from './requests.js';
import { calculatePeriodStats } from './periodStats.js';
import { applySchedule } from './schedule.js';
import { getSettings } from './settings.js';
import { findUser } from './users.js';

/** Everything the mobile home screen shows: profile card, monthly attendance card and the stats grid. */
export async function mobileDashboard(userId) {
  const settings = await getSettings();
  const today = zonedParts(new Date(), settings.timezone).date;
  const user = await findUser(userId);
  const year = today.slice(0, 4);
  const counts = await all("SELECT status, COUNT(*) AS n FROM requests WHERE user_id = ? AND created_at LIKE ? GROUP BY status", userId, `${year}-%`);
  const n = (s) => counts.find((c) => c.status === s)?.n ?? 0;
  const total = counts.reduce((s, c) => s + c.n, 0);
  const missionDays = (await get(
    "SELECT COALESCE(SUM(days), 0) AS d FROM requests WHERE user_id = ? AND type = 'mission' AND status = 'approved' AND start_date LIKE ?",
    userId, `${year}-%`,
  )).d;
  const att = await monthSummary(userId, today.slice(0, 7));
  const status = await todayStatus(userId);

  return {
    profile: {
      id: user.id,
      employee_code: user.employee_code,
      name: user.name,
      job_title: user.job_title,
      branch: user.branch,
      team_name: user.team_name,
      manager: user.supervisor_name,
      role: user.role,
      avatar_url: user.avatar_url,
    },
    attendance: { month: att.month, absence_days: att.absent_days, late_days: att.late_days, present_days: att.present_days },
    today: { date: status.date, can_check_in: status.can_check_in, can_check_out: status.can_check_out, record: status.record },
    leave_balances: await leaveBalances(userId, year),
    requests: { total, pending: n('pending'), approved: n('approved'), rejected: n('rejected') },
    missions: { approved_days: missionDays },
    documents: await documentSummary(userId),
    // Field names used by the app's existing DashboardData model.
    total_requests: total,
    pending_requests: n('pending'),
    approved_requests: n('approved'),
  };
}

/** Totals are employee-days, scoped to the same active employees shown on the daily board. */
async function attendancePeriod(viewer, settings, today, range = {}) {
  const from = range.from ? assertDate(range.from, 'from') : `${today.slice(0, 7)}-01`;
  const to = range.to ? assertDate(range.to, 'to') : today;
  if (from > to) throw badRequest('from must be on or before to');
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 > 365) {
    throw badRequest('Date range cannot exceed 366 days');
  }

  const scope = await scopeFilter(viewer, 'u.id');
  const users = await all(
    `SELECT u.id, u.hire_date, u.created_at, u.work_start, u.work_end, u.late_grace_minutes, u.weekend_days
     FROM users u WHERE u.is_active = 1 AND ${scope.sql}`,
    ...scope.params,
  );
  const ids = users.map((u) => u.id);
  if (!ids.length) return calculatePeriodStats({
    from, to, today, users, records: [], breaks: [], leave: [], holidays: new Set(),
    scheduleForUser: (user) => applySchedule(settings, user), isWorkingDay,
  });

  const placeholders = ids.map(() => '?').join(',');
  const records = await all(
    `SELECT a.id, a.user_id, a.work_date, a.check_in_at, a.check_out_at, a.late_minutes
     FROM attendance a WHERE a.user_id IN (${placeholders}) AND a.work_date BETWEEN ? AND ? AND a.check_in_at IS NOT NULL`,
    ...ids, from, to,
  );
  const breaks = await all(
    `SELECT b.attendance_id, SUM(TIMESTAMPDIFF(SECOND, b.left_at, b.returned_at)) AS seconds_away
     FROM attendance_breaks b JOIN attendance a ON a.id = b.attendance_id
     WHERE a.user_id IN (${placeholders}) AND a.work_date BETWEEN ? AND ? AND b.returned_at IS NOT NULL
     GROUP BY b.attendance_id`,
    ...ids, from, to,
  );
  const leave = await all(
    `SELECT r.user_id, r.start_date, r.end_date FROM requests r
     WHERE r.user_id IN (${placeholders}) AND r.status = 'approved' AND r.type IN ('leave', 'mission')
       AND r.start_date <= ? AND r.end_date >= ?`,
    ...ids, to, from,
  );
  return calculatePeriodStats({
    from, to, today, users, records, breaks, leave, holidays: await holidaySet(from, to),
    scheduleForUser: (user) => applySchedule(settings, user), isWorkingDay,
  });
}

export async function adminOverview(viewer, range = {}) {
  const settings = await getSettings();
  const today = zonedParts(new Date(), settings.timezone).date;
  const period = await attendancePeriod(viewer, settings, today, range);
  const scope = await scopeFilter(viewer, 'u.id');
  const employees = (await get(`SELECT COUNT(*) AS n FROM users u WHERE u.is_active = 1 AND ${scope.sql}`, ...scope.params)).n;
  const board = await dailyBoard(viewer, today);

  const from = addDays(today, -13);
  const aScope = await scopeFilter(viewer, 'a.user_id');
  const trendRows = await all(
    `SELECT a.work_date AS date, SUM(a.late_minutes = 0) AS on_time, SUM(a.late_minutes > 0) AS late
     FROM attendance a WHERE a.check_in_at IS NOT NULL AND a.work_date BETWEEN ? AND ? AND ${aScope.sql}
     GROUP BY a.work_date`,
    from, today, ...aScope.params,
  );
  const trend = [];
  for (let d = from; d <= today; d = addDays(d, 1)) {
    const r = trendRows.find((x) => x.date === d);
    trend.push({ date: d, on_time: r?.on_time ?? 0, late: r?.late ?? 0 });
  }

  return {
    date: today,
    employees,
    teams: viewer.role === 'manager' ? (await get('SELECT COUNT(*) AS n FROM teams')).n : (await get('SELECT COUNT(*) AS n FROM teams WHERE leader_id = ?', viewer.id)).n,
    locations: (await get('SELECT COUNT(*) AS n FROM locations WHERE is_active = 1')).n,
    today: board.counts,
    is_working_day: board.is_working_day,
    requests: await requestStats(viewer),
    pending_requests: (await listRequests(viewer, { status: 'pending' })).slice(0, 6),
    attendance_trend: trend,
    period,
  };
}
