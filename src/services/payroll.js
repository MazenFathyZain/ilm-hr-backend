import { all, get, run, tx } from '../db/index.js';
import { badRequest, notFound } from '../utils/errors.js';
import { monthRange } from '../utils/time.js';
import { assertMonth, assertNumber, assertOneOf, requireFields } from '../utils/validate.js';
import { monthSummary } from './attendance.js';
import { notify } from './notifications.js';

// Line items mirror the salary screen of the mobile app.
export const EARNING_KEYS = ['transport_allowance', 'extra_days', 'overtime', 'bonus_kpi', 'living_allowance', 'reward', 'other'];
export const DEDUCTION_KEYS = ['late', 'absence', 'advances', 'penalties', 'monthly_tax', 'social_insurance', 'health_insurance', 'other'];

const round2 = (n) => Math.round(n * 100) / 100;

function normaliseItems(items, keys, field) {
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const [k, v] of Object.entries(items ?? {})) {
    if (!keys.includes(k)) throw badRequest(`Unknown ${field} item: ${k}`);
    out[k] = round2(assertNumber(v, `${field}.${k}`, { min: 0 }));
  }
  return out;
}

const sum = (items) => round2(Object.values(items).reduce((a, b) => a + b, 0));

function present(row) {
  if (!row) return null;
  return { ...row, earnings: JSON.parse(row.earnings), deductions: JSON.parse(row.deductions) };
}

const SELECT = `SELECT p.*, u.name AS user_name, u.employee_code, u.job_title
                FROM payslips p JOIN users u ON u.id = p.user_id`;

export async function listPayslips({ month, user_id } = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (month) { where.push('p.month = ?'); params.push(assertMonth(month)); }
  if (user_id) { where.push('p.user_id = ?'); params.push(Number(user_id)); }
  return (await all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY p.month DESC, u.name`, ...params)).map(present);
}

export async function findPayslip(id) {
  const p = present(await get(`${SELECT} WHERE p.id = ?`, id));
  if (!p) throw notFound('Payslip');
  return p;
}

/** Suggested figures from attendance, approved requests and penalties/rewards. The manager can edit them. */
export async function suggestPayslip(userId, month) {
  assertMonth(month);
  const user = await get('SELECT id, basic_salary FROM users WHERE id = ?', userId);
  if (!user) throw notFound('Employee');
  const { from, to } = monthRange(month);
  const summary = await monthSummary(userId, month);
  const daily = user.basic_salary / 30;
  const hourly = daily / 8;

  const overtimeHours = (await get(
    "SELECT COALESCE(SUM(hours), 0) AS h FROM requests WHERE user_id = ? AND type = 'overtime' AND status = 'approved' AND start_date BETWEEN ? AND ?",
    userId, from, to,
  )).h;
  const allowances = (await get(
    "SELECT COALESCE(SUM(amount), 0) AS a FROM requests WHERE user_id = ? AND type = 'allowance' AND status = 'approved' AND date(COALESCE(start_date, reviewed_at)) BETWEEN ? AND ?",
    userId, from, to,
  )).a;
  const adj = async (kind) => (await get('SELECT COALESCE(SUM(amount), 0) AS s FROM adjustments WHERE user_id = ? AND kind = ? AND date BETWEEN ? AND ?', userId, kind, from, to)).s;

  const earnings = normaliseItems({ overtime: round2(overtimeHours * hourly), reward: await adj('reward'), other: allowances }, EARNING_KEYS, 'earnings');
  const deductions = normaliseItems({ absence: round2(summary.absent_days * daily), penalties: await adj('penalty') }, DEDUCTION_KEYS, 'deductions');
  return {
    user_id: userId,
    month,
    basic_salary: user.basic_salary,
    earnings,
    deductions,
    basis: { absent_days: summary.absent_days, late_days: summary.late_days, overtime_hours: overtimeHours, daily_rate: round2(daily) },
  };
}

export async function savePayslip(body) {
  requireFields(body, ['user_id', 'month']);
  const userId = Number(body.user_id);
  const month = assertMonth(body.month);
  if (!(await get('SELECT 1 AS ok FROM users WHERE id = ?', userId))) throw notFound('Employee');
  const basic = round2(assertNumber(body.basic_salary ?? 0, 'basic_salary', { min: 0 }));
  const earnings = normaliseItems(body.earnings, EARNING_KEYS, 'earnings');
  const deductions = normaliseItems(body.deductions, DEDUCTION_KEYS, 'deductions');
  const status = assertOneOf(body.status ?? 'draft', ['draft', 'published'], 'status');
  const totalE = sum(earnings);
  const totalD = sum(deductions);

  const before = await get('SELECT status FROM payslips WHERE user_id = ? AND month = ?', userId, month);
  await run(
    `INSERT INTO payslips (user_id, month, basic_salary, earnings, deductions, total_earnings, total_deductions, net_salary, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE basic_salary = VALUES(basic_salary), earnings = VALUES(earnings),
       deductions = VALUES(deductions), total_earnings = VALUES(total_earnings), total_deductions = VALUES(total_deductions),
       net_salary = VALUES(net_salary), status = VALUES(status), updated_at = VALUES(updated_at)`,
    userId, month, basic, JSON.stringify(earnings), JSON.stringify(deductions), totalE, totalD, round2(basic + totalE - totalD), status,
  );
  if (status === 'published' && before?.status !== 'published') await notify(userId, 'Payslip available', `Your payslip for ${month} has been published.`);
  return present(await get(`${SELECT} WHERE p.user_id = ? AND p.month = ?`, userId, month));
}

/** Creates draft payslips (from suggestions) for every active employee that doesn't have one for the month yet. */
export async function generateDrafts(month) {
  assertMonth(month);
  const users = await all('SELECT id FROM users WHERE is_active = 1 AND id NOT IN (SELECT user_id FROM payslips WHERE month = ?)', month);
  await tx(async () => { for (const u of users) await savePayslip({ ...(await suggestPayslip(u.id, month)), status: 'draft' }); });
  return { created: users.length, payslips: await listPayslips({ month }) };
}

export async function publishMonth(month) {
  assertMonth(month);
  const drafts = await all("SELECT id, user_id, month FROM payslips WHERE month = ? AND status = 'draft'", month);
  await tx(async () => {
    for (const d of drafts) {
      await run("UPDATE payslips SET status = 'published', updated_at = UTC_TIMESTAMP(3) WHERE id = ?", d.id);
      await notify(d.user_id, 'Payslip available', `Your payslip for ${d.month} has been published.`);
    }
  });
  return { published: drafts.length };
}

export async function deletePayslip(id) {
  if (!(await get('SELECT 1 AS ok FROM payslips WHERE id = ?', id))) throw notFound('Payslip');
  await run('DELETE FROM payslips WHERE id = ?', id);
}

// ---- Employee ----

export async function ownPayslip(userId, month) {
  if (month) assertMonth(month);
  const row = month
    ? await get("SELECT * FROM payslips WHERE user_id = ? AND month = ? AND status = 'published'", userId, month)
    : await get("SELECT * FROM payslips WHERE user_id = ? AND status = 'published' ORDER BY month DESC LIMIT 1", userId);
  const months = (await all("SELECT month FROM payslips WHERE user_id = ? AND status = 'published' ORDER BY month DESC", userId)).map((r) => r.month);
  return { payslip: present(row), available_months: months };
}
