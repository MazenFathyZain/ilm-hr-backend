import { all, get, run } from '../db/index.js';
import { notFound } from '../utils/errors.js';
import { assertDate, assertNumber, assertOneOf, requireFields } from '../utils/validate.js';
import { notify } from './notifications.js';

const SELECT = `SELECT a.*, u.name AS user_name, c.name AS created_by_name
                FROM adjustments a JOIN users u ON u.id = a.user_id LEFT JOIN users c ON c.id = a.created_by`;

export function listAdjustments({ user_id, kind, from, to } = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (user_id) { where.push('a.user_id = ?'); params.push(Number(user_id)); }
  if (kind) { where.push('a.kind = ?'); params.push(assertOneOf(kind, ['penalty', 'reward'], 'kind')); }
  if (from) { where.push('a.date >= ?'); params.push(assertDate(from, 'from')); }
  if (to) { where.push('a.date <= ?'); params.push(assertDate(to, 'to')); }
  return all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.date DESC, a.id DESC`, ...params);
}

export async function createAdjustment(actor, body) {
  requireFields(body, ['user_id', 'kind', 'reason', 'date']);
  const userId = Number(body.user_id);
  if (!(await get('SELECT 1 AS ok FROM users WHERE id = ?', userId))) throw notFound('Employee');
  const kind = assertOneOf(body.kind, ['penalty', 'reward'], 'kind');
  const amount = assertNumber(body.amount ?? 0, 'amount', { min: 0 });
  const { lastInsertRowid } = await run(
    'INSERT INTO adjustments (user_id, kind, amount, reason, date, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    userId, kind, amount, String(body.reason).trim(), assertDate(body.date, 'date'), actor.id,
  );
  await notify(userId, kind === 'reward' ? 'You received a reward' : 'A penalty was recorded', String(body.reason).trim());
  return get(`${SELECT} WHERE a.id = ?`, lastInsertRowid);
}

export async function deleteAdjustment(id) {
  if (!(await get('SELECT 1 AS ok FROM adjustments WHERE id = ?', id))) throw notFound('Penalty/reward');
  await run('DELETE FROM adjustments WHERE id = ?', id);
}

export const ownAdjustments = (userId) =>
  all('SELECT id, kind, amount, reason, date FROM adjustments WHERE user_id = ? ORDER BY date DESC, id DESC', userId);
