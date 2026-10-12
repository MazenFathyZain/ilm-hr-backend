// Endpoints consumed by the React dashboard (base URL: /api/admin/).
// Managers have full access; team leaders are limited to the members of their own teams.
import fs from 'node:fs';
import { Router } from 'express';
import { authenticate, leadersAndManagers, managersOnly, signToken } from '../middleware/auth.js';
import { assertCanSupervise } from '../services/access.js';
import { createAdjustment, deleteAdjustment, listAdjustments } from '../services/adjustments.js';
import { dailyBoard, history, listAttendance, upsertRecord } from '../services/attendance.js';
import { adminOverview } from '../services/dashboard.js';
import { addDocument, deleteDocument, documentFile, listDocuments, reviewDocument } from '../services/documents.js';
import { createLocation, deleteLocation, findLocation, listLocations, updateLocation } from '../services/locations.js';
import { listNotifications, markAllRead } from '../services/notifications.js';
import {
  deletePayslip, findPayslip, generateDrafts, listPayslips, publishMonth, savePayslip, suggestPayslip,
} from '../services/payroll.js';
import { leaveBalances, listRequests, reviewRequest } from '../services/requests.js';
import { deleteHoliday, getSettings, listHolidays, updateSettings, upsertHoliday } from '../services/settings.js';
import { createTeam, deleteTeam, findTeam, listTeams, updateTeam } from '../services/teams.js';
import {
  changeOwnPassword, createUser, deactivateUser, findUser, listUsers, setUserLocations, updateUser, verifyCredentials,
} from '../services/users.js';
import { forbidden, notFound, unauthorized } from '../utils/errors.js';
import { created, ok } from '../utils/http.js';
import { currentMonth } from '../utils/time.js';
import { assertMonth, toId } from '../utils/validate.js';

const router = Router();

router.post('/auth/login', async (req, res) => {
  const user = await verifyCredentials(req.body?.email, req.body?.password);
  if (!user || !user.is_active) throw unauthorized('Invalid email or password');
  if (user.role === 'employee') throw forbidden('The dashboard is only available to managers and team leaders');
  ok(res, { token: signToken(user), user: await findUser(user.id, user) }, 'Logged in successfully');
});

router.use(authenticate, leadersAndManagers);

router.get('/auth/me', async (req, res) => ok(res, await findUser(req.user.id, req.user)));
router.patch('/auth/password', async (req, res) => { await changeOwnPassword(req.user.id, req.body ?? {}); ok(res, null, 'Password updated'); });
router.get('/notifications', async (req, res) => ok(res, await listNotifications(req.user.id)));
router.patch('/notifications/read-all', async (req, res) => { await markAllRead(req.user.id); ok(res, null); });

router.get('/overview', async (req, res) => ok(res, await adminOverview(req.user)));

// ---- Employees ----
router.get('/users', async (req, res) => ok(res, await listUsers(req.user, req.query)));
router.get('/users/:id', async (req, res) => {
  const id = toId(req.params.id);
  if (id !== req.user.id) await assertCanSupervise(req.user, id);
  const year = String(new Date().getFullYear());
  ok(res, { ...(await findUser(id, req.user)), leave_balances: await leaveBalances(id, req.query.year ?? year) });
});
router.get('/users/:id/attendance', async (req, res) => {
  const id = toId(req.params.id);
  if (id !== req.user.id) await assertCanSupervise(req.user, id);
  ok(res, await history(id, req.query.month ? assertMonth(req.query.month) : currentMonth((await getSettings()).timezone)));
});
router.post('/users', managersOnly, async (req, res) => created(res, await createUser(req.body ?? {}), 'Employee created'));
router.patch('/users/:id', managersOnly, async (req, res) => ok(res, await updateUser(req.user, toId(req.params.id), req.body ?? {}), 'Employee updated'));
router.delete('/users/:id', managersOnly, async (req, res) => ok(res, await deactivateUser(req.user, toId(req.params.id)), 'Employee deactivated'));
router.put('/users/:id/locations', managersOnly, async (req, res) => {
  const id = toId(req.params.id);
  await findUser(id);
  await setUserLocations(id, req.body?.location_ids ?? []);
  ok(res, await findUser(id, req.user), 'Locations updated');
});

// ---- Teams ----
router.get('/teams', async (req, res) => ok(res, await listTeams(req.user)));
router.get('/teams/:id', async (req, res) => ok(res, await findTeam(req.user, toId(req.params.id))));
router.post('/teams', managersOnly, async (req, res) => created(res, await createTeam(req.body ?? {}), 'Team created'));
router.patch('/teams/:id', managersOnly, async (req, res) => ok(res, await updateTeam(toId(req.params.id), req.body ?? {}), 'Team updated'));
router.delete('/teams/:id', managersOnly, async (req, res) => { await deleteTeam(toId(req.params.id)); ok(res, null, 'Team deleted'); });

// ---- Locations (team leaders can see them, only managers can change them) ----
router.get('/locations', async (_req, res) => ok(res, await listLocations()));
router.get('/locations/:id', async (req, res) => ok(res, await findLocation(toId(req.params.id))));
router.post('/locations', managersOnly, async (req, res) => created(res, await createLocation(req.body ?? {}), 'Location created'));
router.patch('/locations/:id', managersOnly, async (req, res) => ok(res, await updateLocation(toId(req.params.id), req.body ?? {}), 'Location updated'));
router.delete('/locations/:id', managersOnly, async (req, res) => { await deleteLocation(toId(req.params.id)); ok(res, null, 'Location deleted'); });

// ---- Attendance ----
router.get('/attendance', async (req, res) => ok(res, await listAttendance(req.user, req.query)));
router.get('/attendance/board', async (req, res) => ok(res, await dailyBoard(req.user, req.query.date)));
router.put('/attendance', managersOnly, async (req, res) => ok(res, await upsertRecord(req.user, req.body ?? {}), 'Attendance saved'));
router.get('/attendance/export', async (req, res) => {
  const rows = await listAttendance(req.user, req.query);
  const cols = ['work_date', 'employee_code', 'user_name', 'team_name', 'check_in_time', 'check_in_location',
    'check_out_time', 'check_out_location', 'late_minutes', 'worked_minutes', 'note'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${req.query.from ?? 'today'}.csv"`);
  res.send(`﻿${csv}`); // BOM so Excel shows Arabic names correctly
});

// ---- Requests ----
router.get('/requests', async (req, res) => ok(res, await listRequests(req.user, req.query)));
router.patch('/requests/:id/approve', async (req, res) =>
  ok(res, await reviewRequest(req.user, toId(req.params.id), 'approved', req.body?.note), 'Request approved'));
router.patch('/requests/:id/reject', async (req, res) =>
  ok(res, await reviewRequest(req.user, toId(req.params.id), 'rejected', req.body?.note), 'Request rejected'));

// ---- Payroll (managers only) ----
router.get('/payslips', managersOnly, async (req, res) => ok(res, await listPayslips(req.query)));
router.get('/payslips/suggest', managersOnly, async (req, res) => ok(res, await suggestPayslip(toId(req.query.user_id, 'user_id'), req.query.month)));
router.get('/payslips/:id', managersOnly, async (req, res) => ok(res, await findPayslip(toId(req.params.id))));
router.put('/payslips', managersOnly, async (req, res) => ok(res, await savePayslip(req.body ?? {}), 'Payslip saved'));
router.post('/payslips/generate', managersOnly, async (req, res) => ok(res, await generateDrafts(req.body?.month), 'Drafts generated'));
router.post('/payslips/publish', managersOnly, async (req, res) => ok(res, await publishMonth(req.body?.month), 'Payslips published'));
router.delete('/payslips/:id', managersOnly, async (req, res) => { await deletePayslip(toId(req.params.id)); ok(res, null, 'Payslip deleted'); });

// ---- Penalties & rewards (managers only) ----
router.get('/adjustments', managersOnly, async (req, res) => ok(res, await listAdjustments(req.query)));
router.post('/adjustments', managersOnly, async (req, res) => created(res, await createAdjustment(req.user, req.body ?? {}), 'Saved'));
router.delete('/adjustments/:id', managersOnly, async (req, res) => { await deleteAdjustment(toId(req.params.id)); ok(res, null, 'Deleted'); });

// ---- Appointment documents (managers only) ----
router.get('/documents', managersOnly, async (req, res) => ok(res, await listDocuments(req.query)));
router.post('/documents', managersOnly, async (req, res) => created(res, await addDocument(Number(req.body?.user_id), req.body?.title)));
router.patch('/documents/:id', managersOnly, async (req, res) => ok(res, await reviewDocument(toId(req.params.id), req.body ?? {}), 'Document updated'));
router.delete('/documents/:id', managersOnly, async (req, res) => { await deleteDocument(toId(req.params.id)); ok(res, null, 'Document deleted'); });
router.get('/documents/:id/file', managersOnly, async (req, res) => {
  const f = await documentFile(toId(req.params.id));
  if (!fs.existsSync(f.absPath)) throw notFound('File');
  res.download(f.absPath, f.name);
});

// ---- Settings & holidays ----
router.get('/settings', async (_req, res) => ok(res, await getSettings()));
router.patch('/settings', managersOnly, async (req, res) => ok(res, await updateSettings(req.body), 'Settings saved'));
router.get('/holidays', async (req, res) => ok(res, await listHolidays(req.query.year)));
router.put('/holidays', managersOnly, async (req, res) => ok(res, await upsertHoliday(req.body ?? {}), 'Holiday saved'));
router.delete('/holidays/:date', managersOnly, async (req, res) => { await deleteHoliday(req.params.date); ok(res, null, 'Holiday deleted'); });

export default router;
