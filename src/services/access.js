// Central permission rules.
//   manager      – full access to everyone and everything.
//   team_leader  – may view and act on the members of the teams they lead (not on themselves).
//   employee     – only their own data.
import { all, get } from '../db/index.js';
import { forbidden, notFound } from '../utils/errors.js';

export const isManager = (user) => user.role === 'manager';

/** IDs of the users a team leader supervises (members of their teams, excluding themselves). */
export async function teamMemberIds(leaderId) {
  const rows = await all(
    `SELECT u.id FROM users u JOIN teams t ON t.id = u.team_id
     WHERE t.leader_id = ? AND u.id <> ?`,
    leaderId, leaderId,
  );
  return rows.map((r) => r.id);
}

/**
 * Returns a SQL fragment + params restricting `column` (a user id column) to what `actor` may see
 * in the admin area. Managers get no restriction.
 */
export async function scopeFilter(actor, column = 'u.id') {
  if (isManager(actor)) return { sql: '1 = 1', params: [] };
  const ids = actor.role === 'team_leader' ? await teamMemberIds(actor.id) : [];
  if (!ids.length) return { sql: '0 = 1', params: [] };
  return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** Can `actor` supervise (view team data of, approve requests for) `targetUserId`? */
export async function canSupervise(actor, targetUserId) {
  if (isManager(actor)) return true;
  if (actor.role !== 'team_leader' || actor.id === targetUserId) return false;
  return !!(await get(
    'SELECT 1 AS ok FROM users u JOIN teams t ON t.id = u.team_id WHERE u.id = ? AND t.leader_id = ?',
    targetUserId, actor.id,
  ));
}

export async function assertCanSupervise(actor, targetUserId) {
  if (!(await get('SELECT 1 AS ok FROM users WHERE id = ?', targetUserId))) throw notFound('Employee');
  if (!(await canSupervise(actor, targetUserId))) throw forbidden('This employee is not in your team');
}
