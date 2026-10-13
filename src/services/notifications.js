import { all, get, run } from '../db/index.js';
import { renderMessage } from './messages.js';
import { pushToUser } from './push.js';

/**
 * Stores an in-app notification in the recipient's language and sends it as a push notification.
 * @param type  key of MESSAGES in messages.js
 * @param vars  values used by the message template
 * @param data  extra payload for the app (e.g. { request_id }) so tapping can open the right screen
 */
export async function notify(userId, type, vars = {}, data = {}) {
  const user = await get('SELECT locale FROM users WHERE id = ?', userId);
  if (!user) return;
  const { title, body } = renderMessage(type, vars, user.locale);
  const payload = { type, ...data };
  const { lastInsertRowid } = await run(
    'INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, ?, ?, ?, ?)',
    userId, type, title, body ?? null, JSON.stringify(payload),
  );
  // Not awaited: the push is delivered in the background and must never fail the request.
  pushToUser(userId, { title, body: body ?? '', data: { ...payload, notification_id: lastInsertRowid } });
}

export async function listNotifications(userId, { limit = 50 } = {}) {
  const items = (await all('SELECT id, type, title, body, data, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit))
    .map((n) => ({ ...n, data: n.data ? JSON.parse(n.data) : null, is_read: !!n.is_read }));
  const { unread } = await get('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0', userId);
  return { unread, items };
}

export const markRead = (userId, id) => run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', id, userId);
export const markAllRead = (userId) => run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', userId);
