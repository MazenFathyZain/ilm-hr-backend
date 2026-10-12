import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { all, get, run } from '../db/index.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { assertOneOf } from '../utils/validate.js';
import { notify } from './notifications.js';

const SELECT = `SELECT d.id, d.user_id, u.name AS user_name, d.title, d.status, d.original_name, d.mime_type,
                       d.note, d.updated_at, d.file_path IS NOT NULL AS has_file
                FROM documents d JOIN users u ON u.id = d.user_id`;

const present = (d) => d && { ...d, has_file: !!d.has_file };

export function listDocuments({ user_id, status } = {}) {
  const where = ['u.is_active = 1'];
  const params = [];
  if (user_id) { where.push('d.user_id = ?'); params.push(Number(user_id)); }
  if (status) { where.push('d.status = ?'); params.push(status); }
  return all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY u.name, d.title`, ...params).map(present);
}

export const ownDocuments = (userId) => all(`${SELECT} WHERE d.user_id = ? ORDER BY d.title`, userId).map(present);

export function documentSummary(userId) {
  const rows = all('SELECT status, COUNT(*) AS n FROM documents WHERE user_id = ? GROUP BY status', userId);
  const total = rows.reduce((s, r) => s + r.n, 0);
  const n = (st) => rows.find((r) => r.status === st)?.n ?? 0;
  return { total, approved: n('approved'), submitted: n('submitted'), missing: n('missing') + n('rejected') };
}

export function addDocument(userId, title) {
  if (!title?.trim()) throw badRequest('title is required');
  if (!get('SELECT 1 FROM users WHERE id = ?', userId)) throw notFound('Employee');
  if (get('SELECT 1 FROM documents WHERE user_id = ? AND title = ?', userId, title.trim())) throw conflict('This document already exists for the employee');
  const { lastInsertRowid } = run('INSERT INTO documents (user_id, title) VALUES (?, ?)', userId, title.trim());
  return present(get(`${SELECT} WHERE d.id = ?`, Number(lastInsertRowid)));
}

function removeFile(relPath) {
  if (relPath) fs.rm(path.join(config.uploadDir, relPath), { force: true }, () => {});
}

/** Attaches an uploaded file (from multer) to the employee's document slot. */
export function uploadOwnDocument(userId, id, file) {
  if (!file) throw badRequest('file is required');
  const doc = get('SELECT * FROM documents WHERE id = ? AND user_id = ?', id, userId);
  if (!doc) { removeFile(path.basename(file.path)); throw notFound('Document'); }
  if (doc.status === 'approved') { removeFile(path.basename(file.path)); throw conflict('This document is already approved'); }
  removeFile(doc.file_path);
  run(
    "UPDATE documents SET file_path = ?, original_name = ?, mime_type = ?, status = 'submitted', note = NULL, updated_at = datetime('now') WHERE id = ?",
    path.basename(file.path), file.originalname, file.mimetype, id,
  );
  return present(get(`${SELECT} WHERE d.id = ?`, id));
}

export function reviewDocument(id, { status, note }) {
  assertOneOf(status, ['approved', 'rejected', 'missing'], 'status');
  const doc = get('SELECT * FROM documents WHERE id = ?', id);
  if (!doc) throw notFound('Document');
  run("UPDATE documents SET status = ?, note = ?, updated_at = datetime('now') WHERE id = ?", status, note ?? null, id);
  if (status !== 'missing') notify(doc.user_id, `Document ${status}`, `${doc.title}${note ? `: ${note}` : ''}`);
  return present(get(`${SELECT} WHERE d.id = ?`, id));
}

export function deleteDocument(id) {
  const doc = get('SELECT * FROM documents WHERE id = ?', id);
  if (!doc) throw notFound('Document');
  removeFile(doc.file_path);
  run('DELETE FROM documents WHERE id = ?', id);
}

export function documentFile(id) {
  const doc = get('SELECT * FROM documents WHERE id = ?', id);
  if (!doc?.file_path) throw notFound('File');
  return { absPath: path.join(config.uploadDir, doc.file_path), name: doc.original_name ?? doc.title, userId: doc.user_id };
}
