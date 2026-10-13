// Push notifications through Firebase Cloud Messaging (shown by Android/iOS even when the app is closed).
// Enabled when a service-account key is configured:
//   FIREBASE_SERVICE_ACCOUNT=/path/to/ilm-hr-firebase-adminsdk.json   (or)
//   FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'    (or GOOGLE_APPLICATION_CREDENTIALS)
import fs from 'node:fs';
import { config } from '../config.js';
import { all, get, run } from '../db/index.js';

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

let transport; // async ({ tokens, title, body, data, badge }) => [{ ok, code? }] – one result per token

async function firebaseTransport() {
  const { serviceAccountPath, serviceAccountJson } = config.firebase;
  const hasAdc = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!serviceAccountPath && !serviceAccountJson && !hasAdc) return null;

  const { cert, getApps, initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getMessaging } = await import('firebase-admin/messaging');
  const credential = serviceAccountJson
    ? cert(JSON.parse(serviceAccountJson))
    : serviceAccountPath ? cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))) : applicationDefault();
  const app = getApps()[0] ?? initializeApp({ credential });
  const messaging = getMessaging(app);

  return async ({ tokens, title, body, data, badge }) => {
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data,
      android: { priority: 'high', notification: { channelId: 'ilm_hr_default', sound: 'default', defaultVibrateTimings: true } },
      apns: { payload: { aps: { sound: 'default', badge } } },
    });
    return res.responses.map((r) => ({ ok: r.success, code: r.error?.code }));
  };
}

let ready;
async function getTransport() {
  if (transport !== undefined) return transport;
  ready ??= firebaseTransport()
    .then((t) => {
      transport = t;
      console.log(t ? 'Push notifications: Firebase Cloud Messaging enabled' : 'Push notifications: disabled (no Firebase service account configured)');
      return t;
    })
    .catch((err) => {
      console.error('Push notifications disabled – Firebase initialisation failed:', err.message);
      transport = null;
      return null;
    });
  return ready;
}

/** Initialises Firebase at start-up so the log shows whether push notifications are enabled. */
export const initPush = () => getTransport();

/** Replaces the sender (used by tests). Pass null to disable sending. */
export function setPushTransport(fn) {
  transport = fn;
}

/** Sends a push to every device of a user. Never throws – a failed push must not break the request. */
export async function pushToUser(userId, { title, body, data = {} }) {
  try {
    const send = await getTransport();
    if (!send) return;
    const rows = await all('SELECT token FROM device_tokens WHERE user_id = ?', userId);
    if (!rows.length) return;
    const { unread } = await get('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0', userId);
    const tokens = rows.map((r) => r.token);
    // FCM data values must be strings.
    const strData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
    const results = await send({ tokens, title, body, data: strData, badge: unread });
    const dead = tokens.filter((_, i) => !results[i]?.ok && DEAD_TOKEN_CODES.has(results[i]?.code));
    if (dead.length) await run(`DELETE FROM device_tokens WHERE token IN (${dead.map(() => '?').join(',')})`, ...dead);
  } catch (err) {
    console.error('Push notification failed:', err.message);
  }
}

// ---- Device registration ----

export async function registerDevice(userId, { token, platform, locale }) {
  await run(
    `INSERT INTO device_tokens (user_id, token, platform) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform), updated_at = UTC_TIMESTAMP(3)`,
    userId, token, platform,
  );
  if (locale) await run('UPDATE users SET locale = ? WHERE id = ?', locale, userId);
}

export const unregisterDevice = (userId, token) => run('DELETE FROM device_tokens WHERE token = ? AND user_id = ?', token, userId);
