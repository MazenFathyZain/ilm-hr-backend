import { all, get, run, tx } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../utils/errors.js';
import { zonedParts } from '../utils/time.js';
import { assertDate, assertNumber, assertOneOf, assertTime, requireFields } from '../utils/validate.js';
import { avatarUrl } from '../utils/files.js';
import { assertCanSupervise, scopeFilter } from './access.js';
import { workingDaysBetween } from './calendar.js';
import { notify } from './notifications.js';
import { getSettings } from './settings.js';

export const REQUEST_TYPES = ['leave', 'allowance', 'mission', 'early_leave', 'overtime', 'complaint'];
export const LEAVE_TYPES = ['annual', 'casual', 'sick', 'unpaid'];
export const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

const SELECT = `
  SELECT r.*, u.name AS user_name, u.employee_code, u.job_title, u.team_id, u.avatar_path AS user_avatar_path, t.name AS team_name,
         rv.name AS reviewer_name
  FROM requests r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN teams t ON t.id = u.team_id
  LEFT JOIN users rv ON rv.id = r.reviewer_id`;

function present(r) {
  if (!r) return r;
  const { user_avatar_path: avatarPath, ...rest } = r;
  return { ...rest, user_avatar_url: avatarUrl(avatarPath) };
}

export async function findRequest(id) {
  const r = await get(`${SELECT} WHERE r.id = ?`, id);
  if (!r) throw notFound('Request');
  return present(r);
}

/** Leave entitlement vs. usage for a calendar year. Pending requests reserve days too. */
export async function leaveBalances(userId, year) {
  const user = await get('SELECT annual_leave_balance, casual_leave_balance FROM users WHERE id = ?', userId);
  const rows = await all(
    `SELECT leave_type, status, SUM(days) AS days FROM requests
     WHERE user_id = ? AND type = 'leave' AND status IN ('approved','pending') AND start_date LIKE ?
     GROUP BY leave_type, status`,
    userId, `${year}-%`,
  );
  const used = (lt, st) => rows.find((r) => r.leave_type === lt && r.status === st)?.days ?? 0;
  const bucket = (lt, total) => {
    const u = used(lt, 'approved');
    const p = used(lt, 'pending');
    return { total, used: u, pending: p, remaining: total - u - p };
  };
  return {
    year,
    annual: bucket('annual', user.annual_leave_balance),
    casual: bucket('casual', user.casual_leave_balance),
    sick: { used: used('sick', 'approved'), pending: used('sick', 'pending') },
    unpaid: { used: used('unpaid', 'approved'), pending: used('unpaid', 'pending') },
  };
}

async function assertNoOverlap(userId, start, end, exceptId = 0) {
  const clash = await get(
    `SELECT id, type FROM requests WHERE user_id = ? AND id <> ? AND status IN ('pending','approved')
       AND type IN ('leave','mission') AND start_date <= ? AND end_date >= ?`,
    userId, exceptId, end, start,
  );
  if (clash) throw conflict(`These dates overlap with request #${clash.id}`, 'overlapping_request');
}

async function buildRequest(userId, body) {
  requireFields(body, ['type']);
  const type = assertOneOf(body.type, REQUEST_TYPES, 'type');
  const settings = await getSettings();
  const reason = typeof body.reason === 'string' ? body.reason.trim() : null;
  const r = { user_id: userId, type, reason: reason || null };

  switch (type) {
    case 'leave':
    case 'mission': {
      requireFields(body, ['start_date', 'end_date']);
      r.start_date = assertDate(body.start_date, 'start_date');
      r.end_date = assertDate(body.end_date, 'end_date');
      if (r.end_date < r.start_date) throw badRequest('end_date must be on or after start_date');
      r.days = (await workingDaysBetween(r.start_date, r.end_date, settings)).length;
      if (r.days === 0) throw badRequest('The selected period contains no working days');
      if (type === 'leave') r.leave_type = assertOneOf(body.leave_type ?? 'annual', LEAVE_TYPES, 'leave_type');
      else {
        requireFields(body, ['destination']);
        r.destination = String(body.destination).trim();
      }
      break;
    }
    case 'allowance':
      requireFields(body, ['amount']);
      r.amount = assertNumber(body.amount, 'amount', { min: 0.01 });
      if (!r.reason) throw badRequest('reason is required');
      if (body.start_date) r.start_date = r.end_date = assertDate(body.start_date, 'start_date');
      break;
    case 'early_leave':
      requireFields(body, ['start_date', 'start_time']);
      r.start_date = r.end_date = assertDate(body.start_date, 'start_date');
      r.start_time = assertTime(body.start_time, 'start_time');
      break;
    case 'overtime':
      requireFields(body, ['start_date', 'hours']);
      r.start_date = r.end_date = assertDate(body.start_date, 'start_date');
      r.hours = assertNumber(body.hours, 'hours', { min: 0.25, max: 16 });
      break;
    case 'complaint':
      if (!r.reason) throw badRequest('reason is required');
      break;
  }
  return r;
}

async function assertBalance(userId, req, { excludingPendingOf } = {}) {
  if (req.type !== 'leave' || !['annual', 'casual'].includes(req.leave_type)) return;
  const bal = (await leaveBalances(userId, req.start_date.slice(0, 4)))[req.leave_type];
  // When approving, this request's own days are already counted as pending.
  const available = bal.remaining + (excludingPendingOf ? req.days : 0);
  if (req.days > available) {
    throw unprocessable(
      `Insufficient ${req.leave_type} leave balance: ${available} day(s) available, ${req.days} requested`,
      'insufficient_balance',
    );
  }
}

export async function createRequest(userId, body) {
  const data = await buildRequest(userId, body);
  if (data.type === 'leave' || data.type === 'mission') await assertNoOverlap(userId, data.start_date, data.end_date);
  await assertBalance(userId, data);
  const cols = Object.keys(data);
  const { lastInsertRowid } = await run(`INSERT INTO requests (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`, data);
  const created = await findRequest(lastInsertRowid);
  await notifyReviewers(created);
  return created;
}

/** Team leader of the requester (if any), otherwise all managers. */
async function notifyReviewers(r) {
  const leader = (await get('SELECT t.leader_id FROM users u JOIN teams t ON t.id = u.team_id WHERE u.id = ? AND t.leader_id <> u.id', r.user_id))?.leader_id;
  const reviewers = leader ? [leader] : (await all("SELECT id FROM users WHERE role = 'manager' AND is_active = 1 AND id <> ?", r.user_id)).map((m) => m.id);
  for (const id of reviewers) await notify(id, 'request_submitted', { type: r.type, name: r.user_name, id: r.id }, { request_id: r.id });
}

export async function listOwnRequests(userId, { status, type } = {}) {
  const where = ['r.user_id = ?'];
  const params = [userId];
  if (status === 'previous') where.push("r.status <> 'pending'");
  else if (status) { where.push('r.status = ?'); params.push(assertOneOf(status, STATUSES, 'status')); }
  if (type) { where.push('r.type = ?'); params.push(assertOneOf(type, REQUEST_TYPES, 'type')); }
  return (await all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC`, ...params)).map(present);
}

export async function cancelOwnRequest(userId, id) {
  const r = await findRequest(id);
  if (r.user_id !== userId) throw notFound('Request');
  if (r.status !== 'pending') throw conflict('Only pending requests can be cancelled');
  await run("UPDATE requests SET status = 'cancelled' WHERE id = ?", id);
  return findRequest(id);
}

export async function listRequests(viewer, { status, type, user_id, team_id, from, to } = {}) {
  const scope = await scopeFilter(viewer, 'r.user_id');
  const where = [scope.sql];
  const params = [...scope.params];
  if (status) { where.push('r.status = ?'); params.push(assertOneOf(status, STATUSES, 'status')); }
  if (type) { where.push('r.type = ?'); params.push(assertOneOf(type, REQUEST_TYPES, 'type')); }
  if (user_id) { where.push('r.user_id = ?'); params.push(Number(user_id)); }
  if (team_id) { where.push('u.team_id = ?'); params.push(Number(team_id)); }
  if (from) { where.push('date(r.created_at) >= ?'); params.push(assertDate(from, 'from')); }
  if (to) { where.push('date(r.created_at) <= ?'); params.push(assertDate(to, 'to')); }
  return (await all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY r.status = 'pending' DESC, r.created_at DESC, r.id DESC LIMIT 2000`, ...params)).map(present);
}

export function reviewRequest(actor, id, decision, note) {
  assertOneOf(decision, ['approved', 'rejected'], 'decision');
  return tx(async () => {
    // Lock the row so two reviewers can't decide the same request at once.
    await get('SELECT id FROM requests WHERE id = ? FOR UPDATE', id);
    const r = await findRequest(id);
    if (r.user_id === actor.id) throw forbidden('You cannot review your own request');
    await assertCanSupervise(actor, r.user_id);
    if (r.status !== 'pending') throw conflict(`This request is already ${r.status}`);
    if (decision === 'approved') await assertBalance(r.user_id, r, { excludingPendingOf: true });

    await run(
      'UPDATE requests SET status = ?, reviewer_id = ?, review_note = ?, reviewed_at = ? WHERE id = ?',
      decision, actor.id, note?.trim() || null, new Date().toISOString(), id,
    );
    await notify(r.user_id, 'request_decided', { type: r.type, decision, reviewer: actor.name, id: r.id, note: note?.trim() || null }, { request_id: r.id });
    return findRequest(id);
  });
}

export async function requestStats(viewer) {
  const scope = await scopeFilter(viewer, 'r.user_id');
  const year = zonedParts(new Date(), (await getSettings()).timezone).date.slice(0, 4);
  return (await all(
    `SELECT r.status, COUNT(*) AS n FROM requests r WHERE ${scope.sql} AND r.created_at LIKE ? GROUP BY r.status`,
    ...scope.params, `${year}-%`,
  )).reduce((acc, row) => ({ ...acc, [row.status]: row.n }), { pending: 0, approved: 0, rejected: 0, cancelled: 0 });
}
