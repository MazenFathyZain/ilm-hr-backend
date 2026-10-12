import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { get } from '../db/index.js';
import { forbidden, unauthorized } from '../utils/errors.js';

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

/** Verifies the bearer token and loads the *current* user, so role/deactivation changes apply immediately. */
export function authenticate(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(unauthorized('Session expired or invalid, please log in again'));
  }

  const user = get('SELECT id, name, email, role, team_id, is_active FROM users WHERE id = ?', payload.sub);
  if (!user || !user.is_active) return next(unauthorized('Account is disabled'));
  req.user = user;
  next();
}

export const requireRole = (...roles) => (req, _res, next) =>
  next(roles.includes(req.user.role) ? undefined : forbidden());

export const managersOnly = requireRole('manager');
export const leadersAndManagers = requireRole('manager', 'team_leader');
