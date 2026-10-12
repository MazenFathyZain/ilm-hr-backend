import { all, get, run } from '../db/index.js';

export function notify(userId, title, body = null) {
  run('INSERT INTO notifications (user_id, title, body) VALUES (?, ?, ?)', userId, title, body);
}

export function listNotifications(userId, { limit = 50 } = {}) {
  const items = all('SELECT id, title, body, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit)
    .map((n) => ({ ...n, is_read: !!n.is_read }));
  const { unread } = get('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0', userId);
  return { unread, items };
}

export const markRead = (userId, id) => run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', id, userId);
export const markAllRead = (userId) => run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', userId);
