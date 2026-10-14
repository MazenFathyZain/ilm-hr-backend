import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

// Tests run against a separate database (dropped and recreated) on the server configured in .env.
process.env.DB_NAME = process.env.TEST_DB_NAME ?? 'ilm_hr_test';
process.env.UPLOAD_DIR = `${process.env.TMPDIR ?? '/tmp'}/hr-test-uploads`;

const { createApp } = await import('../src/app.js');
const { reset, seed } = await import('../src/db/seed.js');
const { closeDb, get: dbGet, initDb } = await import('../src/db/index.js');
await initDb();
await reset();
await seed();

const lookup = async (sql, ...args) => (await dbGet(sql, ...args));

let server;
let base;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { server.close(); await closeDb(); });

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
const userId = async (email) => (await lookup('SELECT id FROM users WHERE email = ?', email)).id;

describe('mobile auth (matches the Flutter models)', () => {
  test('employee login returns token + numeric national_id + type 1', async () => {
    const res = await call('POST', '/mobile/employees/login', { body: { email: 'employee@ilm.test', password: 'password123' } });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.data.type, 1);
    assert.equal(typeof res.body.data.national_id, 'number');
  });

  test('plain employees cannot use the manager login or the dashboard', async () => {
    const body = { email: 'employee@ilm.test', password: 'password123' };
    assert.equal((await call('POST', '/mobile/managers/login', { body })).status, 403);
    assert.equal((await call('POST', '/admin/auth/login', { body })).status, 403);
  });

  test('wrong password is rejected', async () => {
    const res = await call('POST', '/mobile/employees/login', { body: { email: 'employee@ilm.test', password: 'nope' } });
    assert.equal(res.status, 401);
  });

  test('profile update returns national_id as a string', async () => {
    const token = await loginAs('youssef@ilm.test');
    const res = await call('PATCH', '/mobile/employees/profile/update', { token, body: { name: 'يوسف إبراهيم', email: 'youssef@ilm.test', national_id: '29905051234567' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.national_id, '29905051234567');
  });
});

describe('check-in / check-out at assigned locations', () => {
  test('rejects a check-in far from every assigned location', async () => {
    const token = await loginAs('employee@ilm.test');
    const res = await call('POST', '/mobile/attendance/check-in', { token, body: { latitude: 29.9, longitude: 31.2 } });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'outside_location');
    assert.ok(res.body.data.nearest_location.distance_meters > 1000);
  });

  test('rejects positions flagged as mocked by the device', async () => {
    const token = await loginAs('employee@ilm.test');
    const res = await call('POST', '/mobile/attendance/check-in', { token, body: { ...HQ, is_mocked: true } });
    assert.equal(res.body.code, 'mock_location');
  });

  test('rejects a location that exists but is not assigned to the user', async () => {
    const token = await loginAs('youssef@ilm.test'); // only assigned to HQ
    const res = await call('POST', '/mobile/attendance/check-in', { token, body: { latitude: 30.0384, longitude: 31.2108 } }); // Giza
    assert.equal(res.status, 422);
  });

  test('checks in, refuses a second check-in, then checks out', async () => {
    const token = await loginAs('employee@ilm.test');
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
    const mgr = await loginAs('manager@ilm.test', 'admin');
    const created = await call('POST', '/admin/users', { token: mgr, body: { name: 'New Hire', email: 'new@ilm.test', password: 'password123' } });
    assert.equal(created.status, 201);
    const token = await loginAs('new@ilm.test');
    const res = await call('POST', '/mobile/attendance/check-in', { token, body: HQ });
    assert.equal(res.body.code, 'no_location_assigned');
  });

  test('manager can add a location and assign several locations to a user', async () => {
    const mgr = await loginAs('manager@ilm.test', 'admin');
    const loc = await call('POST', '/admin/locations', { token: mgr, body: { name: 'Alexandria', latitude: 31.2001, longitude: 29.9187, radius_meters: 200 } });
    assert.equal(loc.status, 201);
    const id = await userId('new@ilm.test');
    const hqId = (await lookup("SELECT id FROM locations WHERE name LIKE 'Cairo HQ%'")).id;
    const res = await call('PUT', `/admin/users/${id}/locations`, { token: mgr, body: { location_ids: [hqId, loc.body.data.id] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.locations.map((l) => l.name).sort(), ['Alexandria', 'Cairo HQ – Nasr City']);

    const token = await loginAs('new@ilm.test');
    const checkIn = await call('POST', '/mobile/attendance/check-in', { token, body: { latitude: 31.2002, longitude: 29.9188 } });
    assert.equal(checkIn.status, 200);
    assert.equal(checkIn.body.data.record.check_in_location, 'Alexandria');
  });
});

describe('roles: managers vs team leaders', () => {
  test('a team leader only sees the members of their own team', async () => {
    const token = await loginAs('leader@ilm.test', 'admin');
    const res = await call('GET', '/admin/users', { token });
    assert.deepEqual(res.body.data.map((u) => u.email).sort(), ['employee@ilm.test', 'youssef@ilm.test']);
    assert.ok(res.body.data.every((u) => u.basic_salary === undefined), 'salary is hidden from team leaders');
    assert.equal((await call('GET', `/admin/users/${await userId('sara@ilm.test')}`, { token })).status, 403);
  });

  test('a team leader cannot manage employees, locations, teams, payroll or settings', async () => {
    const token = await loginAs('leader@ilm.test', 'admin');
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
    const leader = await loginAs('leader@ilm.test', 'admin');
    const list = await call('GET', '/admin/requests?status=pending', { token: leader });
    const own = list.body.data;
    assert.ok(own.length > 0);
    const allowed = [await userId('employee@ilm.test'), await userId('youssef@ilm.test')];
    assert.ok(own.every((r) => allowed.includes(r.user_id)));

    const approve = await call('PATCH', `/admin/requests/${own[0].id}/approve`, { token: leader, body: { note: 'ok' } });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.data.status, 'approved');

    const saraReq = await lookup("SELECT r.id FROM requests r JOIN users u ON u.id = r.user_id WHERE u.email = 'sara@ilm.test' AND r.status = 'pending'");
    assert.equal((await call('PATCH', `/admin/requests/${saraReq.id}/approve`, { token: leader })).status, 403);
  });

  test("a team leader cannot approve their own request, a manager can", async () => {
    const leaderReq = await lookup("SELECT r.id FROM requests r JOIN users u ON u.id = r.user_id WHERE u.email = 'leader@ilm.test' AND r.status = 'pending'");
    const leader = await loginAs('leader@ilm.test', 'admin');
    assert.equal((await call('PATCH', `/admin/requests/${leaderReq.id}/approve`, { token: leader })).status, 403);
    const mgr = await loginAs('manager@ilm.test', 'admin');
    const res = await call('PATCH', `/admin/requests/${leaderReq.id}/reject`, { token: mgr, body: { note: 'busy week' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'rejected');
  });

  test('team leaders can review from the mobile app too', async () => {
    const token = await loginAs('mona@ilm.test');
    const res = await call('GET', '/mobile/team/requests', { token });
    assert.equal(res.status, 200);
    const target = res.body.data[0];
    const rej = await call('PATCH', `/mobile/team/requests/${target.id}/reject`, { token, body: { note: 'no' } });
    assert.equal(rej.status, 200);
    const employee = await loginAs('youssef@ilm.test');
    assert.equal((await call('GET', '/mobile/team/requests', { token: employee })).status, 403);
  });

  test('the requester is notified about the decision', async () => {
    const token = await loginAs('sara@ilm.test');
    const res = await call('GET', '/mobile/notifications', { token });
    assert.ok(res.body.data.items.some((n) => n.type === 'request_decided' && n.data?.request_id));
  });
});

describe('requests and leave balances', () => {
  test('rejects leave beyond the remaining balance', async () => {
    const token = await loginAs('omar@ilm.test');
    const year = new Date().getFullYear() + 1;
    const res = await call('POST', '/mobile/requests', { token, body: { type: 'leave', leave_type: 'casual', start_date: `${year}-02-01`, end_date: `${year}-02-28` } });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'insufficient_balance');
  });

  test('validates per request type', async () => {
    const token = await loginAs('omar@ilm.test');
    assert.equal((await call('POST', '/mobile/requests', { token, body: { type: 'overtime', start_date: '2026-05-05' } })).status, 400);
    assert.equal((await call('POST', '/mobile/requests', { token, body: { type: 'teleport' } })).status, 400);
    const ok = await call('POST', '/mobile/requests', { token, body: { type: 'early_leave', start_date: '2026-12-01', start_time: '15:00' } });
    assert.equal(ok.status, 201);
    const cancel = await call('DELETE', `/mobile/requests/${ok.body.data.id}`, { token });
    assert.equal(cancel.body.data.status, 'cancelled');
  });

  test('"previous" filter returns non-pending requests only', async () => {
    const token = await loginAs('omar@ilm.test');
    const res = await call('GET', '/mobile/requests?status=previous', { token });
    assert.ok(res.body.data.every((r) => r.status !== 'pending'));
  });
});

describe('payroll', () => {
  test('employees only see published payslips', async () => {
    const mgr = await loginAs('manager@ilm.test', 'admin');
    const id = await userId('youssef@ilm.test');
    const save = await call('PUT', '/admin/payslips', { token: mgr, body: { user_id: id, month: '2030-01', basic_salary: 1000, earnings: { bonus_kpi: 200 }, deductions: { monthly_tax: 50 } } });
    assert.equal(save.status, 200);
    assert.equal(save.body.data.net_salary, 1150);

    const token = await loginAs('youssef@ilm.test');
    assert.equal((await call('GET', '/mobile/salary?month=2030-01', { token })).body.data.payslip, null);
    await call('POST', '/admin/payslips/publish', { token: mgr, body: { month: '2030-01' } });
    assert.equal((await call('GET', '/mobile/salary?month=2030-01', { token })).body.data.payslip.net_salary, 1150);
  });
});

describe('safety rails', () => {
  test('the last active manager cannot be demoted', async () => {
    const mgr = await loginAs('manager@ilm.test', 'admin');
    const res = await call('PATCH', `/admin/users/${await userId('manager@ilm.test')}`, { token: mgr, body: { role: 'employee' } });
    assert.equal(res.status, 400);
  });

  test('deactivated users lose access immediately', async () => {
    const token = await loginAs('new@ilm.test');
    const mgr = await loginAs('manager@ilm.test', 'admin');
    await call('DELETE', `/admin/users/${await userId('new@ilm.test')}`, { token: mgr });
    assert.equal((await call('GET', '/mobile/attendance/today', { token })).status, 401);
  });
});

describe('API documentation', () => {
  test('Swagger UI and the OpenAPI JSON are served', async () => {
    const html = await fetch(`${base}/docs/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /swagger-ui/);
    const spec = await (await fetch(`${base}/docs.json`)).json();
    assert.equal(spec.openapi, '3.0.3');
  });

  test('every route is documented', async () => {
    const { openApiSpec } = await import('../src/docs/openapi.js');
    const { default: mobile } = await import('../src/routes/mobile.js');
    const { default: admin } = await import('../src/routes/admin.js');
    const missing = [];
    for (const [prefix, router] of [['/api/mobile', mobile], ['/api/admin', admin]]) {
      for (const layer of router.stack.filter((l) => l.route)) {
        for (const path of [layer.route.path].flat()) {
          const docPath = prefix + path.replace(/:(\w+)/g, '{$1}');
          for (const method of Object.keys(layer.route.methods)) {
            if (!openApiSpec.paths[docPath]?.[method]) missing.push(`${method.toUpperCase()} ${docPath}`);
          }
        }
      }
    }
    assert.deepEqual(missing, []);
  });
});

describe('automatic check-out when leaving the location', () => {
  const FAR = { latitude: 30.0700, longitude: 31.3500, accuracy: 10 }; // ~2.4 km from Cairo HQ

  test('pings inside keep the employee checked in; a clear departure checks them out; returning reopens the day', async () => {
    const token = await loginAs('youssef@ilm.test'); // assigned to Cairo HQ only
    const id = await userId('youssef@ilm.test');
    await (await import('../src/db/index.js')).run('DELETE FROM attendance WHERE user_id = ? AND work_date >= CURDATE() - INTERVAL 1 DAY', id);

    assert.equal((await call('POST', '/mobile/attendance/check-in', { token, body: HQ })).status, 200);
    const inside = await call('POST', '/mobile/attendance/location-ping', { token, body: { ...HQ, accuracy: 15 } });
    assert.equal(inside.body.data.checked_in, true);
    assert.equal(inside.body.data.inside, true);

    // Poor accuracy near the edge is not treated as leaving.
    const unsure = await call('POST', '/mobile/attendance/location-ping', { token, body: { latitude: 30.0575, longitude: 31.3301, accuracy: 100 } });
    assert.equal(unsure.body.data.auto_checked_out, undefined);

    const left = await call('POST', '/mobile/attendance/location-ping', { token, body: FAR });
    assert.equal(left.body.data.auto_checked_out, true);
    assert.equal(left.body.data.status.checked_out_automatically, true);
    assert.equal(left.body.data.status.can_check_in, true);
    assert.equal(left.body.data.status.record.left_location, true);

    // Further pings while away do nothing.
    assert.equal((await call('POST', '/mobile/attendance/location-ping', { token, body: FAR })).body.data.checked_in, false);

    const back = await call('POST', '/mobile/attendance/check-in', { token, body: HQ });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.data.can_check_out, true);
    assert.equal(back.body.data.record.check_out_at, null);

    const out = await call('POST', '/mobile/attendance/check-out', { token, body: HQ });
    assert.equal(out.body.data.record.check_out_method, 'manual');

    const notes = await call('GET', '/mobile/notifications', { token });
    assert.ok(notes.body.data.items.some((n) => n.type === 'auto_checkout' && n.title === 'تم تسجيل انصرافك تلقائياً'));
  });

  test('managers can switch the behaviour off', async () => {
    const mgr = await loginAs('manager@ilm.test', 'admin');
    await call('PATCH', '/admin/settings', { token: mgr, body: { auto_checkout_on_leave: false } });
    const token = await loginAs('youssef@ilm.test');
    const res = await call('POST', '/mobile/attendance/location-ping', { token, body: FAR });
    assert.equal(res.body.data.tracking, false);
    await call('PATCH', '/admin/settings', { token: mgr, body: { auto_checkout_on_leave: true } });
  });
});

describe('profile photos', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const upload = (path, token, field = 'avatar', type = 'image/png') => {
    const form = new FormData();
    form.append(field, new Blob([png], { type }), 'me.png');
    return fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form }).then(async (r) => ({ status: r.status, body: await r.json() }));
  };

  test('employee uploads a photo; it is served and shown in their profile', async () => {
    const token = await loginAs('sara@ilm.test');
    const res = await upload('/mobile/employees/profile/avatar', token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.data.avatar_url, /^\/api\/uploads\/avatars\/.+\.png$/);
    const img = await fetch(base.replace('/api', '') + res.body.data.avatar_url);
    assert.equal(img.status, 200);
    const profile = await call('GET', '/mobile/employees/dashboard', { token });
    assert.equal(profile.body.data.profile.avatar_url, res.body.data.avatar_url);
  });

  test('non-images are rejected and managers can set or remove photos', async () => {
    const token = await loginAs('sara@ilm.test');
    assert.equal((await upload('/mobile/employees/profile/avatar', token, 'avatar', 'application/pdf')).status, 400);
    const mgr = await loginAs('manager@ilm.test', 'admin');
    const sara = await userId('sara@ilm.test');
    assert.equal((await upload(`/admin/users/${sara}/avatar`, mgr)).status, 200);
    const removed = await call('DELETE', `/admin/users/${sara}/avatar`, { token: mgr });
    assert.equal(removed.body.data.avatar_url, null);
    const leader = await loginAs('leader@ilm.test', 'admin');
    assert.equal((await upload(`/admin/users/${sara}/avatar`, leader)).status, 403);
  });
});

describe('salary on mobile', () => {
  test('only non-zero earnings and deductions are listed', async () => {
    const mgr = await loginAs('manager@ilm.test', 'admin');
    const id = await userId('omar@ilm.test');
    await call('PUT', '/admin/payslips', { token: mgr, body: { user_id: id, month: '2031-02', basic_salary: 9000, earnings: { bonus_kpi: 500 }, deductions: { monthly_tax: 300, advances: 0 }, status: 'published' } });
    const token = await loginAs('omar@ilm.test');
    const res = await call('GET', '/mobile/salary?month=2031-02', { token });
    assert.deepEqual(res.body.data.payslip.earnings_items, [{ key: 'bonus_kpi', amount: 500 }]);
    assert.deepEqual(res.body.data.payslip.deductions_items, [{ key: 'monthly_tax', amount: 300 }]);
  });
});

describe('push notifications', () => {
  test('registered phones get the notification in their language; dead tokens are dropped; logout unregisters', async () => {
    const { setPushTransport } = await import('../src/services/push.js');
    const sent = [];
    setPushTransport(async (msg) => {
      sent.push(msg);
      return msg.tokens.map((t) => (t === 'dead-token' ? { ok: false, code: 'messaging/registration-token-not-registered' } : { ok: true }));
    });
    try {
      const employee = await loginAs('employee@ilm.test');
      const leader = await loginAs('leader@ilm.test', 'admin');
      assert.equal((await call('POST', '/mobile/devices', { token: employee, body: { token: 'phone-1', platform: 'android' } })).status, 200);
      await call('POST', '/mobile/devices', { token: employee, body: { token: 'dead-token', platform: 'ios' } });
      assert.equal((await call('POST', '/mobile/devices', { token: employee, body: { token: 'x', platform: 'pager' } })).status, 400);

      // Arabic by default.
      const req1 = await call('POST', '/mobile/requests', { token: employee, body: { type: 'complaint', reason: 'push test 1' } });
      await call('PATCH', `/admin/requests/${req1.body.data.id}/reject`, { token: leader, body: { note: 'لا' } });
      await new Promise((r) => setTimeout(r, 50));
      const first = sent.find((m) => m.data.request_id === String(req1.body.data.id) && m.data.type === 'request_decided');
      assert.ok(first, 'push sent');
      assert.equal(first.title, 'تم رفض طلب شكوى');
      assert.deepEqual(first.tokens.sort(), ['dead-token', 'phone-1']);

      // The dead token was removed; switching the phone to English changes the language of later pushes.
      await call('POST', '/mobile/devices', { token: employee, body: { token: 'phone-1', platform: 'android', locale: 'en' } });
      const req2 = await call('POST', '/mobile/requests', { token: employee, body: { type: 'complaint', reason: 'push test 2' } });
      await call('PATCH', `/admin/requests/${req2.body.data.id}/approve`, { token: leader });
      await new Promise((r) => setTimeout(r, 50));
      const second = sent.find((m) => m.data.request_id === String(req2.body.data.id) && m.data.type === 'request_decided');
      assert.equal(second.title, 'Your complaint request was approved');
      assert.deepEqual(second.tokens, ['phone-1']);

      // Logout removes the phone: no more pushes.
      await call('DELETE', '/mobile/devices', { token: employee, body: { token: 'phone-1' } });
      const before = sent.length;
      const req3 = await call('POST', '/mobile/requests', { token: employee, body: { type: 'complaint', reason: 'push test 3' } });
      await call('PATCH', `/admin/requests/${req3.body.data.id}/approve`, { token: leader });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(sent.filter((m) => m.data.request_id === String(req3.body.data.id) && m.data.type === 'request_decided').length, 0);
      assert.ok(sent.length >= before);
    } finally {
      setPushTransport(null);
    }
  });
});

describe('error messages in the user language', () => {
  const arCall = (method, path, opts = {}) => fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'accept-language': 'ar', ...(opts.token && { authorization: `Bearer ${opts.token}` }) },
    body: opts.body && JSON.stringify(opts.body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  test('Arabic when the client asks for it, English otherwise; codes stay the same', async () => {
    const ar = await arCall('POST', '/mobile/employees/login', { body: { email: 'employee@ilm.test', password: 'wrong' } });
    assert.equal(ar.status, 401);
    assert.equal(ar.body.message, 'البريد الإلكتروني أو كلمة المرور غير صحيحة');
    assert.equal(ar.body.code, 'unauthorized');
    const en = await call('POST', '/mobile/employees/login', { body: { email: 'employee@ilm.test', password: 'wrong' } });
    assert.equal(en.body.message, 'Invalid email or password');
  });

  test('messages with values keep them (distance, fields, ids)', async () => {
    const token = await loginAs('employee@ilm.test');
    const sara = await loginAs('sara@ilm.test'); // has not checked in during the tests
    const far = await arCall('POST', '/mobile/attendance/check-in', { token: sara, body: { latitude: 29.9, longitude: 31.2 } });
    assert.match(far.body.message, /^أنت على بعد \d+ متر من .+ اقترب لمسافة \d+ متر/);
    assert.equal(far.body.code, 'outside_location');
    const missing = await arCall('POST', '/mobile/requests', { token, body: { type: 'overtime' } });
    assert.equal(missing.body.message, 'يرجى إدخال: تاريخ البداية، عدد الساعات');
    const notFound = await arCall('GET', '/mobile/requests/999999', { token });
    assert.equal(notFound.body.message, 'الطلب غير موجود');
    const noRoute = await arCall('GET', '/mobile/nope', { token });
    assert.equal(noRoute.body.message, 'الرابط غير موجود');
  });

  test('every fixed error message in the code has an Arabic translation', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { localizeError } = await import('../src/utils/errorMessages.js');
    const files = fs.readdirSync('src', { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => path.join('src', f));
    const fallback = new Set(['البيانات المدخلة غير صحيحة', 'يجب تسجيل الدخول أولاً', 'ليس لديك صلاحية للقيام بهذا الإجراء',
      'العنصر المطلوب غير موجود', 'لا يمكن تنفيذ هذا الإجراء حالياً', 'لا يمكن تنفيذ هذا الإجراء']);
    const untranslated = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(badRequest|unauthorized|forbidden|notFound|conflict|unprocessable)\(\s*'([^']+)'/g)) {
        const message = m[1] === 'notFound' ? `${m[2]} not found` : m[2];
        const ar = localizeError(message, 400, 'ar');
        // Generic fallbacks are fine for the default helper messages themselves, not for specific ones.
        if (fallback.has(ar) && !['Authentication required', 'You do not have permission to do this'].includes(message)) {
          untranslated.push(`${file}: ${message}`);
        }
      }
    }
    assert.deepEqual(untranslated, []);
  });
});

describe('per-employee working schedule', () => {
  // Next date (from 2031-03-01) that falls on the given weekday (0 = Sunday … 6 = Saturday).
  const nextWeekday = (wd, from = '2031-03-01') => {
    const d = new Date(`${from}T00:00:00Z`);
    while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  test('managers set own hours and days off; leave days and the daily board follow them', async () => {
    const mgr = await loginAs('manager@ilm.test', 'admin');
    const youssef = await userId('youssef@ilm.test');
    const set = await call('PATCH', `/admin/users/${youssef}`, { token: mgr, body: { work_start: '11:00', work_end: '19:00', weekend_days: [0, 1] } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.data.schedule.custom, true);
    assert.equal(set.body.data.schedule.work_start, '11:00');
    assert.deepEqual(set.body.data.schedule.weekend_days, [0, 1]);
    assert.equal(set.body.data.schedule.late_grace_minutes, 15, 'grace falls back to the company default');

    // Thursday → Saturday: Youssef (off Sun/Mon) works all 3 days; Omar (company weekend Fri/Sat) only Thursday.
    const thu = nextWeekday(4);
    const leave = { type: 'leave', leave_type: 'unpaid', start_date: thu, end_date: addDays(thu, 2) };
    const y = await call('POST', '/mobile/requests', { token: await loginAs('youssef@ilm.test'), body: leave });
    const o = await call('POST', '/mobile/requests', { token: await loginAs('omar@ilm.test'), body: leave });
    assert.equal(y.body.data.days, 3);
    assert.equal(o.body.data.days, 1);

    const monday = nextWeekday(1);
    const board = await call('GET', `/admin/attendance/board?date=${monday}`, { token: mgr });
    const row = (email) => board.body.data.rows.find((r) => r.id === email);
    assert.equal(row(youssef).status, 'day_off');
    assert.equal(row(youssef).work_start, '11:00');
    assert.notEqual(row(await userId('omar@ilm.test')).status, 'day_off');
  });

  test('invalid schedules are rejected and fields can be reset to the company default', async () => {
    const mgr = await loginAs('manager@ilm.test', 'admin');
    const youssef = await userId('youssef@ilm.test');
    const bad = await call('PATCH', `/admin/users/${youssef}`, { token: mgr, body: { work_start: '18:00', work_end: '09:00' } });
    assert.equal(bad.status, 400);
    assert.equal((await call('PATCH', `/admin/users/${youssef}`, { token: mgr, body: { weekend_days: [9] } })).status, 400);
    const reset = await call('PATCH', `/admin/users/${youssef}`, { token: mgr, body: { work_start: '', work_end: null, weekend_days: null } });
    assert.equal(reset.body.data.schedule.custom, false);
    assert.equal(reset.body.data.schedule.work_start, '09:00');
  });
});

describe('staff directory', () => {
  test('every employee can see colleagues with phone and email, but no HR data', async () => {
    const token = await loginAs('employee@ilm.test');
    const res = await call('GET', '/mobile/directory', { token });
    assert.equal(res.status, 200);
    const manager = res.body.data.find((u) => u.email === 'manager@ilm.test');
    assert.ok(manager.phone);
    assert.ok('avatar_url' in manager);
    assert.equal(manager.basic_salary, undefined);
    assert.ok(res.body.data.every((u) => !('national_id' in u)));
    const search = await call('GET', `/mobile/directory?search=${encodeURIComponent('سارة')}`, { token });
    assert.deepEqual(search.body.data.map((u) => u.email), ['sara@ilm.test']);
  });
});
