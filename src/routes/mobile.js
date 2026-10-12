// Endpoints consumed by the Flutter app (base URL: /api/mobile/).
// Paths and payload shapes for login/profile/password match the app's existing Retrofit clients.
import fs from 'node:fs';
import { Router } from 'express';
import { authenticate, leadersAndManagers, signToken } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { checkIn, checkOut, history, todayStatus, dailyBoard } from '../services/attendance.js';
import { ownAdjustments } from '../services/adjustments.js';
import { mobileDashboard } from '../services/dashboard.js';
import { documentFile, ownDocuments, uploadOwnDocument } from '../services/documents.js';
import { listNotifications, markAllRead, markRead } from '../services/notifications.js';
import { ownPayslip } from '../services/payroll.js';
import {
  cancelOwnRequest, createRequest, findRequest, leaveBalances, listOwnRequests, listRequests, reviewRequest,
} from '../services/requests.js';
import { getSettings } from '../services/settings.js';
import { changeOwnPassword, findUser, updateOwnProfile, verifyCredentials } from '../services/users.js';
import { forbidden, notFound, unauthorized } from '../utils/errors.js';
import { created, ok } from '../utils/http.js';
import { currentMonth, zonedParts } from '../utils/time.js';
import { assertMonth, toId } from '../utils/validate.js';

const router = Router();

// The app models national_id as an int in login/profile and as a string in the update response.
const nationalIdNumber = (v) => (v && /^\d+$/.test(v) ? Number(v) : 0);
// type: 1 = employee, 2 = manager / team leader (matches the login screen's user-type selector).
const userType = (role) => (role === 'employee' ? 1 : 2);

function authPayload(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    national_id: nationalIdNumber(user.national_id),
    type: userType(user.role),
    role: user.role,
  };
}

function login(allowedRoles) {
  return (req, res) => {
    const user = verifyCredentials(req.body?.email, req.body?.password);
    if (!user) throw unauthorized('Invalid email or password');
    if (!user.is_active) throw unauthorized('Account is disabled');
    if (!allowedRoles.includes(user.role)) throw forbidden('This account cannot sign in as a manager');
    res.json({ status: 200, message: 'Logged in successfully', data: authPayload(user), token: signToken(user) });
  };
}

// Every active user (including team leaders and managers) can use the employee login to check in.
router.post('/employees/login', login(['employee', 'team_leader', 'manager']));
router.post('/managers/login', login(['team_leader', 'manager']));

router.use(authenticate);

router.post(['/employees/logout', '/managers/logout'], (_req, res) => ok(res, null, 'Logged out'));

// ---- Profile ----
router.get('/employees/profile/get-user', (req, res) => {
  const u = findUser(req.user.id, req.user);
  ok(res, { ...u, national_id: nationalIdNumber(u.national_id), type: userType(u.role) }, 'Profile loaded');
});

router.patch('/employees/profile/update', (req, res) => {
  const u = updateOwnProfile(req.user.id, req.body);
  ok(res, { id: u.id, name: u.name, email: u.email, national_id: u.national_id ?? '' }, 'Profile updated');
});

router.patch('/employees/profile/update-password', (req, res) => {
  changeOwnPassword(req.user.id, req.body ?? {});
  ok(res, null, 'Password updated');
});

// ---- Home ----
router.get('/employees/dashboard', (req, res) => ok(res, mobileDashboard(req.user.id)));

router.get('/settings', (_req, res) => {
  const s = getSettings();
  ok(res, { company_name: s.company_name, timezone: s.timezone, work_start: s.work_start, work_end: s.work_end, currency: s.currency });
});

// ---- Attendance (check-in / check-out replaces face detection) ----
router.get('/attendance/today', (req, res) => ok(res, todayStatus(req.user.id)));
router.post('/attendance/check-in', (req, res) => ok(res, checkIn(req.user.id, req.body), 'Checked in successfully'));
router.post('/attendance/check-out', (req, res) => ok(res, checkOut(req.user.id, req.body), 'Checked out successfully'));
router.get('/attendance/history', (req, res) => {
  const month = req.query.month ? assertMonth(req.query.month) : currentMonth(getSettings().timezone);
  ok(res, history(req.user.id, month));
});

// ---- Requests ----
router.get('/requests', (req, res) => ok(res, listOwnRequests(req.user.id, req.query)));
router.post('/requests', (req, res) => created(res, createRequest(req.user.id, req.body ?? {}), 'Request submitted'));
router.get('/requests/leave-balance', (req, res) => {
  const year = zonedParts(new Date(), getSettings().timezone).date.slice(0, 4);
  ok(res, leaveBalances(req.user.id, req.query.year ?? year));
});
router.get('/requests/:id', (req, res) => {
  const r = findRequest(toId(req.params.id));
  if (r.user_id !== req.user.id) throw notFound('Request');
  ok(res, r);
});
router.delete('/requests/:id', (req, res) => ok(res, cancelOwnRequest(req.user.id, toId(req.params.id)), 'Request cancelled'));

// ---- Salary ----
router.get('/salary', (req, res) => ok(res, ownPayslip(req.user.id, req.query.month)));

// ---- Profile extras ----
router.get('/penalties-rewards', (req, res) => ok(res, ownAdjustments(req.user.id)));
router.get('/documents', (req, res) => ok(res, ownDocuments(req.user.id)));
router.post('/documents/:id/upload', upload.single('file'), (req, res) =>
  ok(res, uploadOwnDocument(req.user.id, toId(req.params.id), req.file), 'Document uploaded'));
router.get('/documents/:id/file', (req, res) => {
  const f = documentFile(toId(req.params.id));
  if (f.userId !== req.user.id || !fs.existsSync(f.absPath)) throw notFound('File');
  res.download(f.absPath, f.name);
});

router.get('/notifications', (req, res) => ok(res, listNotifications(req.user.id)));
router.patch('/notifications/read-all', (req, res) => { markAllRead(req.user.id); ok(res, null); });
router.patch('/notifications/:id/read', (req, res) => { markRead(req.user.id, toId(req.params.id)); ok(res, null); });

// ---- Team leaders / managers on mobile ----
router.get('/team/requests', leadersAndManagers, (req, res) => ok(res, listRequests(req.user, { status: req.query.status ?? 'pending', type: req.query.type })));
router.patch('/team/requests/:id/approve', leadersAndManagers, (req, res) =>
  ok(res, reviewRequest(req.user, toId(req.params.id), 'approved', req.body?.note), 'Request approved'));
router.patch('/team/requests/:id/reject', leadersAndManagers, (req, res) =>
  ok(res, reviewRequest(req.user, toId(req.params.id), 'rejected', req.body?.note), 'Request rejected'));
router.get('/team/attendance', leadersAndManagers, (req, res) => ok(res, dailyBoard(req.user, req.query.date)));

export default router;
