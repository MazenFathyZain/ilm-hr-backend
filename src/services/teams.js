import { all, get, run, setClause, tx } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { pick, requireFields } from '../utils/validate.js';
import { isManager } from './access.js';

const SELECT = `
  SELECT t.id, t.name, t.description, t.leader_id, l.name AS leader_name, t.created_at,
         (SELECT COUNT(*) FROM users m WHERE m.team_id = t.id AND m.is_active = 1) AS member_count
  FROM teams t LEFT JOIN users l ON l.id = t.leader_id`;

const members = (teamId) =>
  all('SELECT id, name, email, job_title, role, is_active FROM users WHERE team_id = ? ORDER BY name', teamId)
    .map((m) => ({ ...m, is_active: !!m.is_active }));

export function listTeams(viewer) {
  return isManager(viewer)
    ? all(`${SELECT} ORDER BY t.name`)
    : all(`${SELECT} WHERE t.leader_id = ? ORDER BY t.name`, viewer.id);
}

export function findTeam(viewer, id) {
  const team = get(`${SELECT} WHERE t.id = ?`, id);
  if (!team) throw notFound('Team');
  if (!isManager(viewer) && team.leader_id !== viewer.id) throw forbidden('You do not lead this team');
  return { ...team, members: members(id) };
}

function validateLeader(leaderId) {
  if (leaderId == null || leaderId === '') return null;
  const leader = get('SELECT id, role, is_active FROM users WHERE id = ?', Number(leaderId));
  if (!leader) throw badRequest('leader_id does not exist');
  if (!leader.is_active) throw badRequest('The selected leader is deactivated');
  return leader;
}

function applyLeaderAndMembers(teamId, input) {
  if (input.leader_id !== undefined) {
    const leader = validateLeader(input.leader_id);
    // Assigning someone as a leader promotes a plain employee to team leader.
    if (leader?.role === 'employee') run("UPDATE users SET role = 'team_leader' WHERE id = ?", leader.id);
    run('UPDATE teams SET leader_id = ? WHERE id = ?', leader?.id ?? null, teamId);
  }
  if (Array.isArray(input.member_ids)) {
    const ids = [...new Set(input.member_ids.map(Number))];
    run('UPDATE users SET team_id = NULL WHERE team_id = ?', teamId);
    for (const uid of ids) {
      if (!get('SELECT 1 FROM users WHERE id = ?', uid)) throw badRequest(`Employee ${uid} does not exist`);
      run('UPDATE users SET team_id = ? WHERE id = ?', teamId, uid);
    }
  }
}

export function createTeam(input) {
  requireFields(input, ['name']);
  if (get('SELECT 1 FROM teams WHERE name = ?', input.name.trim())) throw conflict('A team with this name already exists');
  const id = tx(() => {
    const { lastInsertRowid } = run('INSERT INTO teams (name, description) VALUES (?, ?)', input.name.trim(), input.description ?? null);
    applyLeaderAndMembers(Number(lastInsertRowid), input);
    return Number(lastInsertRowid);
  });
  return findTeam({ role: 'manager' }, id);
}

export function updateTeam(id, input) {
  if (!get('SELECT 1 FROM teams WHERE id = ?', id)) throw notFound('Team');
  const patch = pick(input, ['name', 'description']);
  if (patch.name !== undefined) {
    patch.name = String(patch.name).trim();
    if (!patch.name) throw badRequest('name is required');
    if (get('SELECT 1 FROM teams WHERE name = ? AND id <> ?', patch.name, id)) throw conflict('A team with this name already exists');
  }
  tx(() => {
    if (Object.keys(patch).length) run(`UPDATE teams SET ${setClause(patch)} WHERE id = :id`, { ...patch, id });
    applyLeaderAndMembers(id, input);
  });
  return findTeam({ role: 'manager' }, id);
}

export function deleteTeam(id) {
  if (!get('SELECT 1 FROM teams WHERE id = ?', id)) throw notFound('Team');
  run('DELETE FROM teams WHERE id = ?', id); // members' team_id is set to NULL by the FK
}
