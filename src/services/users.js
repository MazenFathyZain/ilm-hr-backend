import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { all, get, run, setClause, tx } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { avatarUrl } from '../utils/files.js';
import { assertDate, assertEmail, assertNumber, assertOneOf, pick, requireFields } from '../utils/validate.js';
import { isManager, scopeFilter } from './access.js';
import { cleanSchedule, presentSchedule } from './schedule.js';
import { getSettings } from './settings.js';

export const ROLES = ['manager', 'team_leader', 'employee'];

const BASE_SELECT = `
  SELECT u.id, u.employee_code, u.name, u.email, u.national_id, u.phone, u.job_title, u.branch,
         u.role, u.team_id, t.name AS team_name, t.leader_id AS supervisor_id, s.name AS supervisor_name,
         u.hire_date, u.basic_salary, u.annual_leave_balance, u.casual_leave_balance, u.is_active, u.avatar_path, u.created_at,
         u.work_start, u.work_end, u.late_grace_minutes, u.weekend_days
  FROM users u
  LEFT JOIN teams t ON t.id = u.team_id
  LEFT JOIN users s ON s.id = t.leader_id`;

async function locationsFor(userIds) {
  if (!userIds.length) return new Map();
  const rows = await all(
    `SELECT ul.user_id, l.id, l.name FROM user_locations ul JOIN locations l ON l.id = ul.location_id
     WHERE ul.user_id IN (${userIds.map(() => '?').join(',')}) ORDER BY l.name`,
    ...userIds,
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push({ id: r.id, name: r.name });
  }
  return map;
}

/** Shapes a user row for output. Salary is only visible to managers. */
function present(row, locs, viewer, settings) {
  if (!row) return row;
  const { avatar_path: avatarPath, work_start: _ws, work_end: _we, late_grace_minutes: _lg, weekend_days: _wd, ...rest } = row;
  const out = {
    ...rest,
    avatar_url: avatarUrl(avatarPath),
    is_active: !!row.is_active,
    locations: locs.get(row.id) ?? [],
    schedule: presentSchedule(row, settings),
  };
  if (viewer && !isManager(viewer) && viewer.id !== row.id) delete out.basic_salary;
  return out;
}

export async function findUser(id, viewer) {
  const row = await get(`${BASE_SELECT} WHERE u.id = ?`, id);
  if (!row) throw notFound('Employee');
  return present(row, await locationsFor([id]), viewer, await getSettings());
}

export async function listUsers(viewer, { search, role, team_id, active } = {}) {
  const scope = await scopeFilter(viewer, 'u.id');
  const where = [scope.sql];
  const params = [...scope.params];
  if (search) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR u.employee_code LIKE ? OR u.job_title LIKE ?)');
    params.push(...Array(4).fill(`%${search}%`));
  }
  if (role) { where.push('u.role = ?'); params.push(role); }
  if (team_id) { where.push('u.team_id = ?'); params.push(Number(team_id)); }
  if (active === 'true' || active === 'false') { where.push('u.is_active = ?'); params.push(active === 'true' ? 1 : 0); }
  const rows = await all(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY u.name`, ...params);
  const locs = await locationsFor(rows.map((r) => r.id));
  const settings = await getSettings();
  return rows.map((r) => present(r, locs, viewer, settings));
}

const EDITABLE = ['employee_code', 'name', 'email', 'national_id', 'phone', 'job_title', 'branch', 'role', 'team_id',
  'hire_date', 'basic_salary', 'annual_leave_balance', 'casual_leave_balance', 'is_active'];

async function clean(input) {
  const patch = pick(input, EDITABLE);
  if (patch.email !== undefined) patch.email = assertEmail(patch.email);
  if (patch.name !== undefined && !String(patch.name).trim()) throw badRequest('name is required');
  if (patch.role !== undefined) assertOneOf(patch.role, ROLES, 'role');
  if (patch.hire_date) assertDate(patch.hire_date, 'hire_date');
  if (patch.basic_salary !== undefined) patch.basic_salary = assertNumber(patch.basic_salary, 'basic_salary', { min: 0 });
  for (const k of ['annual_leave_balance', 'casual_leave_balance']) {
    if (patch[k] !== undefined) patch[k] = assertNumber(patch[k], k, { min: 0, max: 365 });
  }
  if (patch.team_id === '' || patch.team_id === 0) patch.team_id = null;
  if (patch.team_id != null) {
    patch.team_id = Number(patch.team_id);
    if (!(await get('SELECT 1 AS ok FROM teams WHERE id = ?', patch.team_id))) throw badRequest('team_id does not exist');
  }
  if (patch.national_id != null) patch.national_id = String(patch.national_id).trim();
  if (patch.is_active !== undefined) patch.is_active = patch.is_active ? 1 : 0;
  Object.assign(patch, cleanSchedule(input));
  for (const k of ['employee_code', 'phone', 'job_title', 'branch', 'hire_date', 'national_id']) {
    if (patch[k] === '') patch[k] = null;
  }
  return patch;
}

async function assertUniqueEmail(email, exceptId = 0) {
  if (await get('SELECT 1 AS ok FROM users WHERE email = ? AND id <> ?', email, exceptId)) throw conflict('Email is already used by another employee');
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6) throw badRequest('Password must be at least 6 characters');
}

export async function createUser(input) {
  requireFields(input, ['name', 'email', 'password']);
  validatePassword(input.password);
  const settings = await getSettings();
  const data = {
    annual_leave_balance: settings.default_annual_leave,
    casual_leave_balance: settings.default_casual_leave,
    role: 'employee',
    ...(await clean(input)),
  };
  await assertUniqueEmail(data.email);
  data.password_hash = await bcrypt.hash(input.password, 10);

  const id = await tx(async () => {
    const cols = Object.keys(data);
    const { lastInsertRowid } = await run(
      `INSERT INTO users (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`, data,
    );
    const userId = lastInsertRowid;
    if (!data.employee_code) await run('UPDATE users SET employee_code = ? WHERE id = ?', `EMP-${String(userId).padStart(4, '0')}`, userId);
    for (const title of settings.required_documents) {
      await run('INSERT IGNORE INTO documents (user_id, title) VALUES (?, ?)', userId, title);
    }
    if (Array.isArray(input.location_ids)) await setUserLocations(userId, input.location_ids);
    return userId;
  });
  return findUser(id);
}

async function activeManagerCount(exceptId) {
  return (await get("SELECT COUNT(*) AS n FROM users WHERE role = 'manager' AND is_active = 1 AND id <> ?", exceptId)).n;
}

export async function updateUser(actor, id, input) {
  const existing = await get('SELECT id, role, is_active FROM users WHERE id = ?', id);
  if (!existing) throw notFound('Employee');
  const patch = await clean(input);
  if (patch.email) await assertUniqueEmail(patch.email, id);
  if (input.password) validatePassword(input.password);

  const losesManager = existing.role === 'manager' && existing.is_active &&
    ((patch.role && patch.role !== 'manager') || patch.is_active === 0);
  if (losesManager && (await activeManagerCount(id)) === 0) throw badRequest('At least one active manager is required');
  if (actor.id === id && patch.is_active === 0) throw badRequest('You cannot deactivate your own account');

  const passwordHash = input.password ? await bcrypt.hash(input.password, 10) : null;
  await tx(async () => {
    if (Object.keys(patch).length) await run(`UPDATE users SET ${setClause(patch)} WHERE id = :id`, { ...patch, id });
    // A user who is no longer a team leader should not keep leading teams.
    if (patch.role === 'employee') await run('UPDATE teams SET leader_id = NULL WHERE leader_id = ?', id);
    if (passwordHash) await run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, id);
    if (Array.isArray(input.location_ids)) await setUserLocations(id, input.location_ids);
  });
  return findUser(id);
}

/** "Deleting" an employee deactivates them so their attendance and payroll history is kept. */
export function deactivateUser(actor, id) {
  return updateUser(actor, id, { is_active: false });
}

export async function setUserLocations(userId, locationIds) {
  const ids = [...new Set(locationIds.map(Number))];
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) throw badRequest('location_ids must be a list of ids');
  if (ids.length) {
    const found = await all(`SELECT id FROM locations WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    if (found.length !== ids.length) throw badRequest('One or more locations do not exist');
  }
  await tx(async () => {
    await run('DELETE FROM user_locations WHERE user_id = ?', userId);
    for (const lid of ids) await run('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)', userId, lid);
  });
}

// ---- Self-service (mobile profile) ----

export async function updateOwnProfile(userId, input) {
  const patch = pick(input, ['name', 'email', 'national_id', 'phone']);
  if (patch.email !== undefined) {
    patch.email = assertEmail(patch.email);
    await assertUniqueEmail(patch.email, userId);
  }
  if (patch.name !== undefined && !String(patch.name).trim()) throw badRequest('name is required');
  if (patch.national_id !== undefined) patch.national_id = String(patch.national_id).trim();
  if (Object.keys(patch).length) await run(`UPDATE users SET ${setClause(patch)} WHERE id = :id`, { ...patch, id: userId });
  return findUser(userId);
}

export async function changeOwnPassword(userId, { current_password, password, password_confirmation }) {
  requireFields({ current_password, password }, ['current_password', 'password']);
  if (password_confirmation !== undefined && password !== password_confirmation) {
    throw badRequest('Password confirmation does not match');
  }
  validatePassword(password);
  const { password_hash } = await get('SELECT password_hash FROM users WHERE id = ?', userId);
  if (!(await bcrypt.compare(current_password, password_hash))) throw forbidden('Current password is incorrect');
  await run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(password, 10), userId);
}

export async function verifyCredentials(email, password) {
  const row = typeof email === 'string' ? await get('SELECT * FROM users WHERE email = ?', email.trim()) : null;
  if (!row || typeof password !== 'string' || !(await bcrypt.compare(password, row.password_hash))) return null;
  return row;
}

// ---- Profile photo ----

const avatarFile = (name) => path.join(config.uploadDir, 'avatars', path.basename(name));

/** Stores a newly uploaded photo (from multer) as the user's avatar and deletes the previous one. */
export async function setAvatar(userId, file) {
  if (!file) throw badRequest('avatar image is required');
  const row = await get('SELECT avatar_path FROM users WHERE id = ?', userId);
  if (!row) {
    fs.rm(file.path, { force: true }, () => {});
    throw notFound('Employee');
  }
  await run('UPDATE users SET avatar_path = ? WHERE id = ?', path.basename(file.path), userId);
  if (row.avatar_path) fs.rm(avatarFile(row.avatar_path), { force: true }, () => {});
  return findUser(userId);
}

export async function removeAvatar(userId) {
  const row = await get('SELECT avatar_path FROM users WHERE id = ?', userId);
  if (!row) throw notFound('Employee');
  await run('UPDATE users SET avatar_path = NULL WHERE id = ?', userId);
  if (row.avatar_path) fs.rm(avatarFile(row.avatar_path), { force: true }, () => {});
  return findUser(userId);
}

/** Company directory for the mobile app: every active colleague with contact details (no salary or HR data). */
export async function directory({ search } = {}) {
  const where = ['u.is_active = 1'];
  const params = [];
  if (search) {
    where.push('(u.name LIKE ? OR u.job_title LIKE ? OR u.phone LIKE ? OR u.email LIKE ? OR t.name LIKE ?)');
    params.push(...Array(5).fill(`%${search}%`));
  }
  const rows = await all(
    `SELECT u.id, u.name, u.job_title, u.branch, u.phone, u.email, u.role, u.avatar_path, t.name AS team_name
     FROM users u LEFT JOIN teams t ON t.id = u.team_id
     WHERE ${where.join(' AND ')} ORDER BY u.name`,
    ...params,
  );
  return rows.map(({ avatar_path: avatarPath, ...r }) => ({ ...r, avatar_url: avatarUrl(avatarPath) }));
}
