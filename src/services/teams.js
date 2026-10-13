import { all, get, run, setClause, tx } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { avatarUrl } from '../utils/files.js';
import { pick, requireFields } from '../utils/validate.js';
import { isManager } from './access.js';

const SELECT = `
  SELECT t.id, t.name, t.description, t.leader_id, l.name AS leader_name, t.created_at,
         (SELECT COUNT(*) FROM users m WHERE m.team_id = t.id AND m.is_active = 1) AS member_count
  FROM teams t LEFT JOIN users l ON l.id = t.leader_id`;

const members = async (teamId) =>
  (await all('SELECT id, name, email, job_title, role, is_active, avatar_path FROM users WHERE team_id = ? ORDER BY name', teamId))
    .map(({ avatar_path: avatarPath, ...m }) => ({ ...m, avatar_url: avatarUrl(avatarPath), is_active: !!m.is_active }));

export function listTeams(viewer) {
  return isManager(viewer)
    ? all(`${SELECT} ORDER BY t.name`)
    : all(`${SELECT} WHERE t.leader_id = ? ORDER BY t.name`, viewer.id);
}

export async function findTeam(viewer, id) {
  const team = await get(`${SELECT} WHERE t.id = ?`, id);
  if (!team) throw notFound('Team');
  if (!isManager(viewer) && team.leader_id !== viewer.id) throw forbidden('You do not lead this team');
  return { ...team, members: await members(id) };
}

async function validateLeader(leaderId) {
  if (leaderId == null || leaderId === '') return null;
  const leader = await get('SELECT id, role, is_active FROM users WHERE id = ?', Number(leaderId));
  if (!leader) throw badRequest('leader_id does not exist');
  if (!leader.is_active) throw badRequest('The selected leader is deactivated');
  return leader;
}

async function applyLeaderAndMembers(teamId, input) {
  if (input.leader_id !== undefined) {
    const leader = await validateLeader(input.leader_id);
    // Assigning someone as a leader promotes a plain employee to team leader.
    if (leader?.role === 'employee') await run("UPDATE users SET role = 'team_leader' WHERE id = ?", leader.id);
    await run('UPDATE teams SET leader_id = ? WHERE id = ?', leader?.id ?? null, teamId);
  }
  if (Array.isArray(input.member_ids)) {
    const ids = [...new Set(input.member_ids.map(Number))];
    await run('UPDATE users SET team_id = NULL WHERE team_id = ?', teamId);
    for (const uid of ids) {
      if (!(await get('SELECT 1 AS ok FROM users WHERE id = ?', uid))) throw badRequest(`Employee ${uid} does not exist`);
      await run('UPDATE users SET team_id = ? WHERE id = ?', teamId, uid);
    }
  }
}

export async function createTeam(input) {
  requireFields(input, ['name']);
  if (await get('SELECT 1 AS ok FROM teams WHERE name = ?', input.name.trim())) throw conflict('A team with this name already exists');
  const id = await tx(async () => {
    const { lastInsertRowid } = await run('INSERT INTO teams (name, description) VALUES (?, ?)', input.name.trim(), input.description ?? null);
    await applyLeaderAndMembers(lastInsertRowid, input);
    return lastInsertRowid;
  });
  return findTeam({ role: 'manager' }, id);
}

export async function updateTeam(id, input) {
  if (!(await get('SELECT 1 AS ok FROM teams WHERE id = ?', id))) throw notFound('Team');
  const patch = pick(input, ['name', 'description']);
  if (patch.name !== undefined) {
    patch.name = String(patch.name).trim();
    if (!patch.name) throw badRequest('name is required');
    if (await get('SELECT 1 AS ok FROM teams WHERE name = ? AND id <> ?', patch.name, id)) throw conflict('A team with this name already exists');
  }
  await tx(async () => {
    if (Object.keys(patch).length) await run(`UPDATE teams SET ${setClause(patch)} WHERE id = :id`, { ...patch, id });
    await applyLeaderAndMembers(id, input);
  });
  return findTeam({ role: 'manager' }, id);
}

export async function deleteTeam(id) {
  if (!(await get('SELECT 1 AS ok FROM teams WHERE id = ?', id))) throw notFound('Team');
  await run('DELETE FROM teams WHERE id = ?', id); // members' team_id is set to NULL by the FK
}
