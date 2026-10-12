import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

process.env.DB_FILE = ':memory:';
process.env.UPLOAD_DIR = `${process.env.TMPDIR ?? '/tmp'}/hr-test-uploads`;

const { createApp } = await import('../src/app.js');
const { seed } = await import('../src/db/seed.js');
const { get } = await import('../src/db/index.js');
seed();

let server;
let base;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const tokens = {};
async function loginAs(email, area = 'mobile') {
  const key = `${area}:${email}`;
  if (!tokens[key]) {
    const res = area === 'mobile'
      ? await call('POST', '/mobile/employees/login', { body: { email, password: 'password123' } })
      : await call('POST', '/admin/auth/login', { body: { email, password: 'password123' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    tokens[key] = area === 'mobile' ? res.body.token : res.body.data.token;
  }
  return tokens[key];
}

const HQ = { latitude: 30.0562, longitude: 31.3302 };
const userId = (email) => get('SELECT id FROM users WHERE email = ?', email).id;

describe('mobile auth (matches the Flutter models)', () => {
  test('employee login returns token + numeric national_id + type 1', async () => {
    const res = await call('POST', '/mobile/employees/login', { body: { email: 'employee@meshkatnour.test', password: 'password123' } });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.data.type, 1);
    assert.equal(typeof res.body.data.national_id, 'number');
  });

  test('plain employees cannot use the manager login or the dashboard', async () => {
    const body = { email: 'employee@meshkatnour.test', password: 'password123' };
    assert.equal((await call('POST', '/mobile/managers/login', { body })).status, 403);
    assert.equal((await call('POST', '/admin/auth/login', { body })).status, 403);
  });

  test('wrong password is rejected', async () => {
    const res = await call('POST', '/mobile/employees/login', { body: { email: 'employee@meshkatnour.test', password: 'nope' } });
    assert.equal(res.status, 401);
  });

  test('profile update returns national_id as a string', async () => {
    const token = await loginAs('youssef@meshkatnour.test');
    const res = await call('PATCH', '/mobile/employees/profile/update', { token, body: { name: 'يوسف إبراهيم', email: 'youssef@meshkatnour.test', national_id: '29905051234567' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.national_id, '29905051234567');
  });
});

describe('check-in / check-out at assigned locations', () => {
  test('rejects a check-in far from every assigned location', async () => {
    const token = await loginAs('employee@meshkatnour.test');
    const res = await call('POST', '/mobile/attendance/check-in', { token, body: { latitude: 29.9, longitude: 31.2 } });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'outside_location');
    assert.ok(res.body.data.nearest_location.distance_meters > 1000);
  });

  test('rejects positions flagged as mocked by the device', async () => {
    const token = await loginAs('employee@meshkatnour.test');
    const res = await call('POST', '/mobile/attendance/check-in', { token, body: { ...HQ, is_mocked: true } });
    assert.equal(res.body.code, 'mock_location');
  });

  test('rejects a location that exists but is not assigned to the user', async () => {
    const token = await loginAs('youssef@meshkatnour.test'); // only assigned to HQ
    const res = await call('POST', '/mobile/attendance/check-in', { token, body: { latitude: 30.0384, longitude: 31.2108 } }); // Giza
    assert.equal(res.status, 422);
  });

  test('checks in, refuses a second check-in, then checks out', async () => {
    const token = await loginAs('employee@meshkatnour.test');
    const first = await call('POST', '/mobile/attendance/check-in', { token, body: HQ });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.can_check_out, true);
    assert.equal(first.body.data.record.check_in_location, 'Cairo HQ – Nasr City');

    assert.equal((await call('POST', '/mobile/attendance/check-in', { token, body: HQ })).body.code, 'already_checked_in');
    const out = await call('POST', '/mobile/attendance/check-out', { token, body: HQ });
    assert.equal(out.status, 200);
    assert.equal(out.body.data.can_check_out, false);
    assert.equal((await call('POST', '/mobile/attendance/check-out', { token, body: HQ })).body.code, 'already_checked_out');
  });

  test('a user with no locations gets a clear error', async () => {
    const mgr = await loginAs('manager@meshkatnour.test', 'admin');
    const created = await call('POST', '/admin/users', { token: mgr, body: { name: 'New Hire', email: 'new@meshkatnour.test', password: 'password123' } });
    assert.equal(created.status, 201);
    const token = await loginAs('new@meshkatnour.test');
    const res = await call('POST', '/mobile/attendance/check-in', { token, body: HQ });
    assert.equal(res.body.code, 'no_location_assigned');
  });

  test('manager can add a location and assign several locations to a user', async () => {
    const mgr = await loginAs('manager@meshkatnour.test', 'admin');
    const loc = await call('POST', '/admin/locations', { token: mgr, body: { name: 'Alexandria', latitude: 31.2001, longitude: 29.9187, radius_meters: 200 } });
    assert.equal(loc.status, 201);
    const id = userId('new@meshkatnour.test');
    const hqId = get("SELECT id FROM locations WHERE name LIKE 'Cairo HQ%'").id;
    const res = await call('PUT', `/admin/users/${id}/locations`, { token: mgr, body: { location_ids: [hqId, loc.body.data.id] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.locations.map((l) => l.name).sort(), ['Alexandria', 'Cairo HQ – Nasr City']);

    const token = await loginAs('new@meshkatnour.test');
    const checkIn = await call('POST', '/mobile/attendance/check-in', { token, body: { latitude: 31.2002, longitude: 29.9188 } });
    assert.equal(checkIn.status, 200);
    assert.equal(checkIn.body.data.record.check_in_location, 'Alexandria');
  });
});

describe('roles: managers vs team leaders', () => {
  test('a team leader only sees the members of their own team', async () => {
    const token = await loginAs('leader@meshkatnour.test', 'admin');
    const res = await call('GET', '/admin/users', { token });
    assert.deepEqual(res.body.data.map((u) => u.email).sort(), ['employee@meshkatnour.test', 'youssef@meshkatnour.test']);
    assert.ok(res.body.data.every((u) => u.basic_salary === undefined), 'salary is hidden from team leaders');
    assert.equal((await call('GET', `/admin/users/${userId('sara@meshkatnour.test')}`, { token })).status, 403);
  });

  test('a team leader cannot manage employees, locations, teams, payroll or settings', async () => {
    const token = await loginAs('leader@meshkatnour.test', 'admin');
    const checks = [
      ['POST', '/admin/users', { name: 'x', email: 'x@x.com', password: 'secret123' }],
      ['POST', '/admin/locations', { name: 'x', latitude: 1, longitude: 1 }],
      ['POST', '/admin/teams', { name: 'x' }],
      ['GET', '/admin/payslips'],
      ['PATCH', '/admin/settings', { work_start: '08:00' }],
      ['PUT', '/admin/attendance', { user_id: 1, work_date: '2026-01-01' }],
    ];
    for (const [method, path, body] of checks) {
      assert.equal((await call(method, path, { token, body })).status, 403, `${method} ${path}`);
    }
  });

  test('a team leader approves requests from their team but not from other teams', async () => {
    const leader = await loginAs('leader@meshkatnour.test', 'admin');
    const list = await call('GET', '/admin/requests?status=pending', { token: leader });
    const own = list.body.data;
    assert.ok(own.length > 0);
    assert.ok(own.every((r) => ['employee@meshkatnour.test', 'youssef@meshkatnour.test'].includes(get('SELECT email FROM users WHERE id = ?', r.user_id).email)));

    const approve = await call('PATCH', `/admin/requests/${own[0].id}/approve`, { token: leader, body: { note: 'ok' } });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.data.status, 'approved');

    const saraReq = get("SELECT r.id FROM requests r JOIN users u ON u.id = r.user_id WHERE u.email = 'sara@meshkatnour.test' AND r.status = 'pending'");
    assert.equal((await call('PATCH', `/admin/requests/${saraReq.id}/approve`, { token: leader })).status, 403);
  });

  test("a team leader cannot approve their own request, a manager can", async () => {
    const leaderReq = get("SELECT r.id FROM requests r JOIN users u ON u.id = r.user_id WHERE u.email = 'leader@meshkatnour.test' AND r.status = 'pending'");
    const leader = await loginAs('leader@meshkatnour.test', 'admin');
    assert.equal((await call('PATCH', `/admin/requests/${leaderReq.id}/approve`, { token: leader })).status, 403);
    const mgr = await loginAs('manager@meshkatnour.test', 'admin');
    const res = await call('PATCH', `/admin/requests/${leaderReq.id}/reject`, { token: mgr, body: { note: 'busy week' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'rejected');
  });

  test('team leaders can review from the mobile app too', async () => {
    const token = await loginAs('mona@meshkatnour.test');
    const res = await call('GET', '/mobile/team/requests', { token });
    assert.equal(res.status, 200);
    const target = res.body.data[0];
    const rej = await call('PATCH', `/mobile/team/requests/${target.id}/reject`, { token, body: { note: 'no' } });
    assert.equal(rej.status, 200);
    const employee = await loginAs('youssef@meshkatnour.test');
    assert.equal((await call('GET', '/mobile/team/requests', { token: employee })).status, 403);
  });

  test('the requester is notified about the decision', async () => {
    const token = await loginAs('sara@meshkatnour.test');
    const res = await call('GET', '/mobile/notifications', { token });
    assert.ok(res.body.data.items.some((n) => /rejected|approved/.test(n.title)));
  });
});

describe('requests and leave balances', () => {
  test('rejects leave beyond the remaining balance', async () => {
    const token = await loginAs('omar@meshkatnour.test');
    const year = new Date().getFullYear() + 1;
    const res = await call('POST', '/mobile/requests', { token, body: { type: 'leave', leave_type: 'casual', start_date: `${year}-02-01`, end_date: `${year}-02-28` } });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'insufficient_balance');
  });

  test('validates per request type', async () => {
    const token = await loginAs('omar@meshkatnour.test');
    assert.equal((await call('POST', '/mobile/requests', { token, body: { type: 'overtime', start_date: '2026-05-05' } })).status, 400);
    assert.equal((await call('POST', '/mobile/requests', { token, body: { type: 'teleport' } })).status, 400);
    const ok = await call('POST', '/mobile/requests', { token, body: { type: 'early_leave', start_date: '2026-12-01', start_time: '15:00' } });
    assert.equal(ok.status, 201);
    const cancel = await call('DELETE', `/mobile/requests/${ok.body.data.id}`, { token });
    assert.equal(cancel.body.data.status, 'cancelled');
  });

  test('"previous" filter returns non-pending requests only', async () => {
    const token = await loginAs('omar@meshkatnour.test');
    const res = await call('GET', '/mobile/requests?status=previous', { token });
    assert.ok(res.body.data.every((r) => r.status !== 'pending'));
  });
});

describe('payroll', () => {
  test('employees only see published payslips', async () => {
    const mgr = await loginAs('manager@meshkatnour.test', 'admin');
    const id = userId('youssef@meshkatnour.test');
    const save = await call('PUT', '/admin/payslips', { token: mgr, body: { user_id: id, month: '2030-01', basic_salary: 1000, earnings: { bonus_kpi: 200 }, deductions: { monthly_tax: 50 } } });
    assert.equal(save.status, 200);
    assert.equal(save.body.data.net_salary, 1150);

    const token = await loginAs('youssef@meshkatnour.test');
    assert.equal((await call('GET', '/mobile/salary?month=2030-01', { token })).body.data.payslip, null);
    await call('POST', '/admin/payslips/publish', { token: mgr, body: { month: '2030-01' } });
    assert.equal((await call('GET', '/mobile/salary?month=2030-01', { token })).body.data.payslip.net_salary, 1150);
  });
});

describe('safety rails', () => {
  test('the last active manager cannot be demoted', async () => {
    const mgr = await loginAs('manager@meshkatnour.test', 'admin');
    const res = await call('PATCH', `/admin/users/${userId('manager@meshkatnour.test')}`, { token: mgr, body: { role: 'employee' } });
    assert.equal(res.status, 400);
  });

  test('deactivated users lose access immediately', async () => {
    const token = await loginAs('new@meshkatnour.test');
    const mgr = await loginAs('manager@meshkatnour.test', 'admin');
    await call('DELETE', `/admin/users/${userId('new@meshkatnour.test')}`, { token: mgr });
    assert.equal((await call('GET', '/mobile/attendance/today', { token })).status, 401);
  });
});
