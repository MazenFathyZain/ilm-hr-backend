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

router.post('/auth/login', (req, res) => {
  const user = verifyCredentials(req.body?.email, req.body?.password);
  if (!user || !user.is_active) throw unauthorized('Invalid email or password');
  if (user.role === 'employee') throw forbidden('The dashboard is only available to managers and team leaders');
  ok(res, { token: signToken(user), user: findUser(user.id, user) }, 'Logged in successfully');
});

router.use(authenticate, leadersAndManagers);

router.get('/auth/me', (req, res) => ok(res, findUser(req.user.id, req.user)));
router.patch('/auth/password', (req, res) => { changeOwnPassword(req.user.id, req.body ?? {}); ok(res, null, 'Password updated'); });
router.get('/notifications', (req, res) => ok(res, listNotifications(req.user.id)));
router.patch('/notifications/read-all', (req, res) => { markAllRead(req.user.id); ok(res, null); });

router.get('/overview', (req, res) => ok(res, adminOverview(req.user)));

// ---- Employees ----
router.get('/users', (req, res) => ok(res, listUsers(req.user, req.query)));
router.get('/users/:id', (req, res) => {
  const id = toId(req.params.id);
  if (id !== req.user.id) assertCanSupervise(req.user, id);
  const year = String(new Date().getFullYear());
  ok(res, { ...findUser(id, req.user), leave_balances: leaveBalances(id, req.query.year ?? year) });
});
router.get('/users/:id/attendance', (req, res) => {
  const id = toId(req.params.id);
  if (id !== req.user.id) assertCanSupervise(req.user, id);
  ok(res, history(id, req.query.month ? assertMonth(req.query.month) : currentMonth(getSettings().timezone)));
});
router.post('/users', managersOnly, (req, res) => created(res, createUser(req.body ?? {}), 'Employee created'));
router.patch('/users/:id', managersOnly, (req, res) => ok(res, updateUser(req.user, toId(req.params.id), req.body ?? {}), 'Employee updated'));
router.delete('/users/:id', managersOnly, (req, res) => ok(res, deactivateUser(req.user, toId(req.params.id)), 'Employee deactivated'));
router.put('/users/:id/locations', managersOnly, (req, res) => {
  const id = toId(req.params.id);
  findUser(id);
  setUserLocations(id, req.body?.location_ids ?? []);
  ok(res, findUser(id, req.user), 'Locations updated');
});

// ---- Teams ----
router.get('/teams', (req, res) => ok(res, listTeams(req.user)));
router.get('/teams/:id', (req, res) => ok(res, findTeam(req.user, toId(req.params.id))));
router.post('/teams', managersOnly, (req, res) => created(res, createTeam(req.body ?? {}), 'Team created'));
router.patch('/teams/:id', managersOnly, (req, res) => ok(res, updateTeam(toId(req.params.id), req.body ?? {}), 'Team updated'));
router.delete('/teams/:id', managersOnly, (req, res) => { deleteTeam(toId(req.params.id)); ok(res, null, 'Team deleted'); });

// ---- Locations (team leaders can see them, only managers can change them) ----
router.get('/locations', (_req, res) => ok(res, listLocations()));
router.get('/locations/:id', (req, res) => ok(res, findLocation(toId(req.params.id))));
router.post('/locations', managersOnly, (req, res) => created(res, createLocation(req.body ?? {}), 'Location created'));
router.patch('/locations/:id', managersOnly, (req, res) => ok(res, updateLocation(toId(req.params.id), req.body ?? {}), 'Location updated'));
router.delete('/locations/:id', managersOnly, (req, res) => { deleteLocation(toId(req.params.id)); ok(res, null, 'Location deleted'); });

// ---- Attendance ----
router.get('/attendance', (req, res) => ok(res, listAttendance(req.user, req.query)));
router.get('/attendance/board', (req, res) => ok(res, dailyBoard(req.user, req.query.date)));
router.put('/attendance', managersOnly, (req, res) => ok(res, upsertRecord(req.user, req.body ?? {}), 'Attendance saved'));
router.get('/attendance/export', (req, res) => {
  const rows = listAttendance(req.user, req.query);
  const cols = ['work_date', 'employee_code', 'user_name', 'team_name', 'check_in_time', 'check_in_location',
    'check_out_time', 'check_out_location', 'late_minutes', 'worked_minutes', 'note'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${req.query.from ?? 'today'}.csv"`);
  res.send(`﻿${csv}`); // BOM so Excel shows Arabic names correctly
});

// ---- Requests ----
router.get('/requests', (req, res) => ok(res, listRequests(req.user, req.query)));
router.patch('/requests/:id/approve', (req, res) =>
  ok(res, reviewRequest(req.user, toId(req.params.id), 'approved', req.body?.note), 'Request approved'));
router.patch('/requests/:id/reject', (req, res) =>
  ok(res, reviewRequest(req.user, toId(req.params.id), 'rejected', req.body?.note), 'Request rejected'));

// ---- Payroll (managers only) ----
router.get('/payslips', managersOnly, (req, res) => ok(res, listPayslips(req.query)));
router.get('/payslips/suggest', managersOnly, (req, res) => ok(res, suggestPayslip(toId(req.query.user_id, 'user_id'), req.query.month)));
router.get('/payslips/:id', managersOnly, (req, res) => ok(res, findPayslip(toId(req.params.id))));
router.put('/payslips', managersOnly, (req, res) => ok(res, savePayslip(req.body ?? {}), 'Payslip saved'));
router.post('/payslips/generate', managersOnly, (req, res) => ok(res, generateDrafts(req.body?.month), 'Drafts generated'));
router.post('/payslips/publish', managersOnly, (req, res) => ok(res, publishMonth(req.body?.month), 'Payslips published'));
router.delete('/payslips/:id', managersOnly, (req, res) => { deletePayslip(toId(req.params.id)); ok(res, null, 'Payslip deleted'); });

// ---- Penalties & rewards (managers only) ----
router.get('/adjustments', managersOnly, (req, res) => ok(res, listAdjustments(req.query)));
router.post('/adjustments', managersOnly, (req, res) => created(res, createAdjustment(req.user, req.body ?? {}), 'Saved'));
router.delete('/adjustments/:id', managersOnly, (req, res) => { deleteAdjustment(toId(req.params.id)); ok(res, null, 'Deleted'); });

// ---- Appointment documents (managers only) ----
router.get('/documents', managersOnly, (req, res) => ok(res, listDocuments(req.query)));
router.post('/documents', managersOnly, (req, res) => created(res, addDocument(Number(req.body?.user_id), req.body?.title)));
router.patch('/documents/:id', managersOnly, (req, res) => ok(res, reviewDocument(toId(req.params.id), req.body ?? {}), 'Document updated'));
router.delete('/documents/:id', managersOnly, (req, res) => { deleteDocument(toId(req.params.id)); ok(res, null, 'Document deleted'); });
router.get('/documents/:id/file', managersOnly, (req, res) => {
  const f = documentFile(toId(req.params.id));
  if (!fs.existsSync(f.absPath)) throw notFound('File');
  res.download(f.absPath, f.name);
});

// ---- Settings & holidays ----
router.get('/settings', (_req, res) => ok(res, getSettings()));
router.patch('/settings', managersOnly, (req, res) => ok(res, updateSettings(req.body), 'Settings saved'));
router.get('/holidays', (req, res) => ok(res, listHolidays(req.query.year)));
router.put('/holidays', managersOnly, (req, res) => ok(res, upsertHoliday(req.body ?? {}), 'Holiday saved'));
router.delete('/holidays/:date', managersOnly, (req, res) => { deleteHoliday(req.params.date); ok(res, null, 'Holiday deleted'); });

export default router;
