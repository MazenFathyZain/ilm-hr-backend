import { all, get } from '../db/index.js';
import { addDays, zonedParts } from '../utils/time.js';
import { scopeFilter } from './access.js';
import { dailyBoard, monthSummary, todayStatus } from './attendance.js';
import { documentSummary } from './documents.js';
import { leaveBalances, listRequests, requestStats } from './requests.js';
import { getSettings } from './settings.js';
import { findUser } from './users.js';

/** Everything the mobile home screen shows: profile card, monthly attendance card and the stats grid. */
export function mobileDashboard(userId) {
  const settings = getSettings();
  const today = zonedParts(new Date(), settings.timezone).date;
  const user = findUser(userId);
  const year = today.slice(0, 4);
  const counts = all("SELECT status, COUNT(*) AS n FROM requests WHERE user_id = ? AND created_at LIKE ? GROUP BY status", userId, `${year}-%`);
  const n = (s) => counts.find((c) => c.status === s)?.n ?? 0;
  const total = counts.reduce((s, c) => s + c.n, 0);
  const missionDays = get(
    "SELECT COALESCE(SUM(days), 0) AS d FROM requests WHERE user_id = ? AND type = 'mission' AND status = 'approved' AND start_date LIKE ?",
    userId, `${year}-%`,
  ).d;
  const att = monthSummary(userId, today.slice(0, 7));
  const status = todayStatus(userId);

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
    },
    attendance: { month: att.month, absence_days: att.absent_days, late_days: att.late_days, present_days: att.present_days },
    today: { date: status.date, can_check_in: status.can_check_in, can_check_out: status.can_check_out, record: status.record },
    leave_balances: leaveBalances(userId, year),
    requests: { total, pending: n('pending'), approved: n('approved'), rejected: n('rejected') },
    missions: { approved_days: missionDays },
    documents: documentSummary(userId),
    // Field names used by the app's existing DashboardData model.
    total_requests: total,
    pending_requests: n('pending'),
    approved_requests: n('approved'),
  };
}

export function adminOverview(viewer) {
  const settings = getSettings();
  const today = zonedParts(new Date(), settings.timezone).date;
  const scope = scopeFilter(viewer, 'u.id');
  const employees = get(`SELECT COUNT(*) AS n FROM users u WHERE u.is_active = 1 AND ${scope.sql}`, ...scope.params).n;
  const board = dailyBoard(viewer, today);

  const from = addDays(today, -13);
  const aScope = scopeFilter(viewer, 'a.user_id');
  const trendRows = all(
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
    teams: viewer.role === 'manager' ? get('SELECT COUNT(*) AS n FROM teams').n : get('SELECT COUNT(*) AS n FROM teams WHERE leader_id = ?', viewer.id).n,
    locations: get('SELECT COUNT(*) AS n FROM locations WHERE is_active = 1').n,
    today: board.counts,
    is_working_day: board.is_working_day,
    requests: requestStats(viewer),
    pending_requests: listRequests(viewer, { status: 'pending' }).slice(0, 6),
    attendance_trend: trend,
  };
}
