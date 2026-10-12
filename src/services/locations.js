import { all, get, run, setClause, tx } from '../db/index.js';
import { notFound } from '../utils/errors.js';
import { assertNumber, pick, requireFields } from '../utils/validate.js';

const SELECT = `
  SELECT l.*, (SELECT COUNT(*) FROM user_locations ul WHERE ul.location_id = l.id) AS assigned_count
  FROM locations l`;

const present = (l) => l && { ...l, is_active: !!l.is_active };

export const listLocations = async () => (await all(`${SELECT} ORDER BY l.name`)).map(present);

export async function findLocation(id) {
  const loc = present(await get(`${SELECT} WHERE l.id = ?`, id));
  if (!loc) throw notFound('Location');
  loc.users = await all(
    'SELECT u.id, u.name, u.job_title FROM user_locations ul JOIN users u ON u.id = ul.user_id WHERE ul.location_id = ? ORDER BY u.name',
    id,
  );
  return loc;
}

function clean(input) {
  const patch = pick(input, ['name', 'address', 'latitude', 'longitude', 'radius_meters', 'is_active']);
  if (patch.latitude !== undefined) patch.latitude = assertNumber(patch.latitude, 'latitude', { min: -90, max: 90 });
  if (patch.longitude !== undefined) patch.longitude = assertNumber(patch.longitude, 'longitude', { min: -180, max: 180 });
  if (patch.radius_meters !== undefined) patch.radius_meters = Math.round(assertNumber(patch.radius_meters, 'radius_meters', { min: 10, max: 10_000 }));
  if (patch.is_active !== undefined) patch.is_active = patch.is_active ? 1 : 0;
  if (patch.name !== undefined) patch.name = String(patch.name).trim();
  return patch;
}

async function setUsers(locationId, userIds) {
  await run('DELETE FROM user_locations WHERE location_id = ?', locationId);
  for (const uid of new Set(userIds.map(Number))) {
    await run('INSERT IGNORE INTO user_locations (user_id, location_id) SELECT id, ? FROM users WHERE id = ?', locationId, uid);
  }
}

export async function createLocation(input) {
  requireFields(input, ['name', 'latitude', 'longitude']);
  const data = { radius_meters: 100, ...clean(input) };
  const id = await tx(async () => {
    const cols = Object.keys(data);
    const { lastInsertRowid } = await run(`INSERT INTO locations (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`, data);
    if (Array.isArray(input.user_ids)) await setUsers(lastInsertRowid, input.user_ids);
    return lastInsertRowid;
  });
  return findLocation(id);
}

export async function updateLocation(id, input) {
  if (!(await get('SELECT 1 AS ok FROM locations WHERE id = ?', id))) throw notFound('Location');
  const patch = clean(input);
  await tx(async () => {
    if (Object.keys(patch).length) await run(`UPDATE locations SET ${setClause(patch)} WHERE id = :id`, { ...patch, id });
    if (Array.isArray(input.user_ids)) await setUsers(id, input.user_ids);
  });
  return findLocation(id);
}

export async function deleteLocation(id) {
  if (!(await get('SELECT 1 AS ok FROM locations WHERE id = ?', id))) throw notFound('Location');
  await run('DELETE FROM locations WHERE id = ?', id);
}

export const assignedLocations = (userId) =>
  all(
    `SELECT l.id, l.name, l.address, l.latitude, l.longitude, l.radius_meters
     FROM user_locations ul JOIN locations l ON l.id = ul.location_id
     WHERE ul.user_id = ? AND l.is_active = 1 ORDER BY l.name`,
    userId,
  );
