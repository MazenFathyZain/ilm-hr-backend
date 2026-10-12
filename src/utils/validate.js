import { badRequest } from './errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function requireFields(body, fields) {
  const missing = fields.filter((f) => body?.[f] === undefined || body?.[f] === null || body?.[f] === '');
  if (missing.length) throw badRequest(`Missing required field(s): ${missing.join(', ')}`);
}

export function isDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

export function assertDate(value, field) {
  if (!isDate(value)) throw badRequest(`${field} must be a date in YYYY-MM-DD format`);
  return value;
}

export function assertTime(value, field) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) throw badRequest(`${field} must be a time in HH:MM format`);
  return value;
}

export function assertMonth(value, field = 'month') {
  if (typeof value !== 'string' || !MONTH_RE.test(value)) throw badRequest(`${field} must be in YYYY-MM format`);
  return value;
}

export function assertNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`${field} must be a number between ${min} and ${max}`);
  }
  return n;
}

export function assertOneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function assertEmail(value) {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw badRequest('email is invalid');
  return value.trim().toLowerCase();
}

export function toId(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${field} must be a positive integer`);
  return n;
}

/** Picks only the listed keys that are present (not undefined) in body. */
export function pick(body, keys) {
  const out = {};
  for (const k of keys) if (body?.[k] !== undefined) out[k] = body[k];
  return out;
}
