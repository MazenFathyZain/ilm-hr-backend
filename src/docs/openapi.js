// OpenAPI 3 description of the HR API, served by Swagger UI at /api/docs (raw JSON at /api/docs.json).

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const envelope = (data = { type: 'object' }) => ({
  type: 'object',
  properties: { status: { type: 'integer', example: 200 }, message: { type: 'string', example: 'OK' }, data },
});
const ok = (data, description = 'Success') => ({ description, content: { 'application/json': { schema: envelope(data) } } });
const errors = (...codes) => Object.fromEntries(codes.map((c) => [c, { $ref: `#/components/responses/E${c}` }]));
const body = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });
const idParam = (name = 'id') => ({ name, in: 'path', required: true, schema: { type: 'integer' } });
const q = (name, schema = { type: 'string' }, description) => ({ name, in: 'query', schema, ...(description && { description }) });
const listOf = (name) => ({ type: 'array', items: ref(name) });

const op = (tag, summary, { params, requestBody, response = ok(), errs = [400, 401, 403], extra = {}, security } = {}) => ({
  tags: [tag],
  summary,
  ...(params && { parameters: params }),
  ...(requestBody && { requestBody }),
  ...(security && { security }),
  responses: { 200: response, ...errors(...errs) },
  ...extra,
});

const position = {
  type: 'object',
  required: ['latitude', 'longitude'],
  properties: {
    latitude: { type: 'number', example: 30.0562 },
    longitude: { type: 'number', example: 31.3302 },
    accuracy: { type: 'number', description: 'GPS accuracy in metres (informational)' },
    is_mocked: { type: 'boolean', description: 'true if the OS reports a mock-location provider – the request is rejected' },
  },
};

const M = 'Mobile';
const A = 'Dashboard';

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Ilm HR API',
    version: '2.1.0',
    description: [
      'REST API for the **Ilm HR** mobile app (`/api/mobile`) and admin dashboard (`/api/admin`).',
      '',
      '1. Log in with `POST /api/mobile/employees/login` or `POST /api/admin/auth/login`.',
      '2. Click **Authorize** and paste the returned token.',
      '',
      'Every response uses the envelope `{ status, message, data }`. Errors are `{ status, message, code, data? }`.',
      'Roles: **manager** (full access), **team_leader** (limited to the members of their teams), **employee** (own data only).',
      'Demo password for every seeded account: `password123` (e.g. `manager@ilm.test`, `leader@ilm.test`, `employee@ilm.test`).',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'This server' }, { url: 'http://2.24.9.126:4000', description: 'Hosted' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: M, description: 'Endpoints used by the Flutter app' },
    { name: `${M} – Team`, description: 'Team leaders / managers on mobile' },
    { name: A, description: 'Endpoints used by the React dashboard (managers & team leaders)' },
    { name: `${A} – Payroll`, description: 'Managers only' },
    { name: `${A} – Settings`, description: 'Managers only (read: managers & team leaders)' },
    { name: 'System' },
  ],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    responses: {
      E400: { description: 'Validation error', content: { 'application/json': { schema: ref('Error') } } },
      E401: { description: 'Missing / invalid token', content: { 'application/json': { schema: ref('Error') } } },
      E403: { description: 'Not allowed for this role or team', content: { 'application/json': { schema: ref('Error') } } },
      E404: { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
      E409: { description: 'Conflict (e.g. already checked in)', content: { 'application/json': { schema: ref('Error') } } },
      E422: { description: 'Business rule failed (e.g. outside location, insufficient balance)', content: { 'application/json': { schema: ref('Error') } } },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          status: { type: 'integer', example: 422 },
          message: { type: 'string', example: 'You are 340 m away from Cairo HQ. Move within 150 m to check in/out.' },
          code: { type: 'string', example: 'outside_location' },
          data: { type: 'object' },
        },
      },
      Login: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', example: 'employee@ilm.test' }, password: { type: 'string', example: 'password123' } } },
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, employee_code: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' },
          national_id: { type: 'string' }, phone: { type: 'string' }, job_title: { type: 'string' }, branch: { type: 'string' },
          role: { type: 'string', enum: ['manager', 'team_leader', 'employee'] }, team_id: { type: 'integer', nullable: true },
          team_name: { type: 'string', nullable: true }, supervisor_id: { type: 'integer', nullable: true }, supervisor_name: { type: 'string', nullable: true },
          hire_date: { type: 'string', format: 'date' }, basic_salary: { type: 'number', description: 'Only visible to managers and the user themselves' },
          annual_leave_balance: { type: 'integer' }, casual_leave_balance: { type: 'integer' }, is_active: { type: 'boolean' },
          locations: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } },
        },
      },
      UserInput: {
        type: 'object',
        properties: {
          name: { type: 'string' }, email: { type: 'string' }, password: { type: 'string', minLength: 6 }, employee_code: { type: 'string' },
          national_id: { type: 'string' }, phone: { type: 'string' }, job_title: { type: 'string' }, branch: { type: 'string' },
          role: { type: 'string', enum: ['manager', 'team_leader', 'employee'] }, team_id: { type: 'integer', nullable: true },
          hire_date: { type: 'string', format: 'date' }, basic_salary: { type: 'number' }, annual_leave_balance: { type: 'integer' },
          casual_leave_balance: { type: 'integer' }, is_active: { type: 'boolean' },
          location_ids: { type: 'array', items: { type: 'integer' }, description: 'Check-in locations the user may use' },
        },
      },
      Team: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, name: { type: 'string' }, description: { type: 'string' }, leader_id: { type: 'integer', nullable: true },
          leader_name: { type: 'string', nullable: true }, member_count: { type: 'integer' },
          members: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, role: { type: 'string' } } } },
        },
      },
      TeamInput: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string' }, leader_id: { type: 'integer', nullable: true }, member_ids: { type: 'array', items: { type: 'integer' } } },
      },
      Location: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, name: { type: 'string' }, address: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' },
          radius_meters: { type: 'integer' }, is_active: { type: 'boolean' }, assigned_count: { type: 'integer' },
        },
      },
      LocationInput: {
        type: 'object',
        properties: {
          name: { type: 'string', example: 'Cairo HQ' }, address: { type: 'string' }, latitude: { type: 'number', example: 30.0561 },
          longitude: { type: 'number', example: 31.3301 }, radius_meters: { type: 'integer', example: 150 }, is_active: { type: 'boolean' },
          user_ids: { type: 'array', items: { type: 'integer' }, description: 'Replaces the employees assigned to this location' },
        },
      },
      AttendanceRecord: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, user_id: { type: 'integer' }, user_name: { type: 'string' }, work_date: { type: 'string', format: 'date' },
          check_in_at: { type: 'string', format: 'date-time' }, check_out_at: { type: 'string', format: 'date-time', nullable: true },
          check_in_time: { type: 'string', example: '08:57', description: 'Company time zone' }, check_out_time: { type: 'string', nullable: true },
          check_in_location: { type: 'string' }, check_out_location: { type: 'string', nullable: true },
          late_minutes: { type: 'integer' }, is_late: { type: 'boolean' }, worked_minutes: { type: 'integer', nullable: true }, note: { type: 'string', nullable: true },
        },
      },
      TodayStatus: {
        type: 'object',
        properties: {
          date: { type: 'string', format: 'date' }, server_time: { type: 'string' }, work_start: { type: 'string' }, work_end: { type: 'string' },
          is_working_day: { type: 'boolean' }, can_check_in: { type: 'boolean' }, can_check_out: { type: 'boolean' },
          record: { allOf: [ref('AttendanceRecord')], nullable: true }, locations: listOf('Location'),
        },
      },
      Request: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, user_id: { type: 'integer' }, user_name: { type: 'string' },
          type: { type: 'string', enum: ['leave', 'allowance', 'mission', 'early_leave', 'overtime', 'complaint'] },
          leave_type: { type: 'string', enum: ['annual', 'casual', 'sick', 'unpaid'], nullable: true },
          start_date: { type: 'string', format: 'date' }, end_date: { type: 'string', format: 'date' }, days: { type: 'integer' },
          start_time: { type: 'string' }, hours: { type: 'number' }, amount: { type: 'number' }, destination: { type: 'string' }, reason: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'cancelled'] }, reviewer_name: { type: 'string' }, review_note: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      RequestInput: {
        type: 'object',
        required: ['type'],
        description: [
          'Required fields depend on `type`:',
          '- **leave**: `leave_type`, `start_date`, `end_date`',
          '- **mission**: `start_date`, `end_date`, `destination`',
          '- **allowance**: `amount`, `reason`',
          '- **early_leave**: `start_date`, `start_time` (HH:MM)',
          '- **overtime**: `start_date`, `hours`',
          '- **complaint**: `reason`',
        ].join('\n'),
        properties: {
          type: { type: 'string', enum: ['leave', 'allowance', 'mission', 'early_leave', 'overtime', 'complaint'], example: 'leave' },
          leave_type: { type: 'string', enum: ['annual', 'casual', 'sick', 'unpaid'], example: 'annual' },
          start_date: { type: 'string', format: 'date', example: '2026-11-02' }, end_date: { type: 'string', format: 'date', example: '2026-11-04' },
          start_time: { type: 'string', example: '14:00' }, hours: { type: 'number' }, amount: { type: 'number' }, destination: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      Review: { type: 'object', properties: { note: { type: 'string', description: 'Sent to the employee' } } },
      Payslip: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, user_id: { type: 'integer' }, month: { type: 'string', example: '2026-09' }, basic_salary: { type: 'number' },
          earnings: { type: 'object', additionalProperties: { type: 'number' } }, deductions: { type: 'object', additionalProperties: { type: 'number' } },
          total_earnings: { type: 'number' }, total_deductions: { type: 'number' }, net_salary: { type: 'number' },
          status: { type: 'string', enum: ['draft', 'published'] },
        },
      },
      PayslipInput: {
        type: 'object',
        required: ['user_id', 'month'],
        properties: {
          user_id: { type: 'integer' }, month: { type: 'string', example: '2026-10' }, basic_salary: { type: 'number' },
          earnings: { type: 'object', description: 'transport_allowance, extra_days, overtime, bonus_kpi, living_allowance, reward, other', additionalProperties: { type: 'number' } },
          deductions: { type: 'object', description: 'late, absence, advances, penalties, monthly_tax, social_insurance, health_insurance, other', additionalProperties: { type: 'number' } },
          status: { type: 'string', enum: ['draft', 'published'] },
        },
      },
      Adjustment: {
        type: 'object',
        properties: { user_id: { type: 'integer' }, kind: { type: 'string', enum: ['penalty', 'reward'] }, amount: { type: 'number' }, reason: { type: 'string' }, date: { type: 'string', format: 'date' } },
      },
      Document: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, user_id: { type: 'integer' }, title: { type: 'string' }, status: { type: 'string', enum: ['missing', 'submitted', 'approved', 'rejected'] },
          original_name: { type: 'string', nullable: true }, note: { type: 'string', nullable: true }, has_file: { type: 'boolean' },
        },
      },
      Settings: {
        type: 'object',
        properties: {
          company_name: { type: 'string' }, timezone: { type: 'string', example: 'Africa/Cairo' }, work_start: { type: 'string', example: '09:00' },
          work_end: { type: 'string', example: '17:00' }, late_grace_minutes: { type: 'integer' }, weekend_days: { type: 'array', items: { type: 'integer' }, example: [5, 6] },
          default_annual_leave: { type: 'integer' }, default_casual_leave: { type: 'integer' }, required_documents: { type: 'array', items: { type: 'string' } },
          currency: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/api/health': { get: op('System', 'Health check', { security: [], errs: [], response: { description: 'OK' } }) },

    // ---------------- Mobile ----------------
    '/api/mobile/employees/login': {
      post: op(M, 'Log in (any active user)', {
        security: [], requestBody: body(ref('Login')), errs: [400, 401],
        response: { description: 'Logged in', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'integer' }, message: { type: 'string' }, token: { type: 'string' }, data: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string' }, national_id: { type: 'integer' }, type: { type: 'integer', description: '1 = employee, 2 = manager / team leader' }, role: { type: 'string' } } } } } } } },
      }),
    },
    '/api/mobile/managers/login': { post: op(M, 'Log in as manager / team leader', { security: [], requestBody: body(ref('Login')), errs: [400, 401, 403] }) },
    '/api/mobile/employees/logout': { post: op(M, 'Log out (stateless – client discards the token)') },
    '/api/mobile/managers/logout': { post: op(M, 'Log out (stateless – client discards the token)') },
    '/api/mobile/employees/profile/get-user': { get: op(M, 'Own profile', { response: ok(ref('User')) }) },
    '/api/mobile/employees/profile/update': {
      patch: op(M, 'Update own profile', { requestBody: body({ type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, national_id: { type: 'string' }, phone: { type: 'string' } } }) }),
    },
    '/api/mobile/employees/profile/update-password': {
      patch: op(M, 'Change own password', { requestBody: body({ type: 'object', required: ['current_password', 'password'], properties: { current_password: { type: 'string' }, password: { type: 'string' }, password_confirmation: { type: 'string' } } }) }),
    },
    '/api/mobile/employees/dashboard': { get: op(M, 'Home screen: profile card, monthly attendance, leave balances, request counts') },
    '/api/mobile/settings': { get: op(M, 'Company name, time zone and working hours') },
    '/api/mobile/attendance/today': { get: op(M, "Today's check-in status and the user's assigned locations", { response: ok(ref('TodayStatus')) }) },
    '/api/mobile/attendance/check-in': {
      post: op(M, 'Check in at one of the assigned locations', {
        requestBody: body(position), response: ok(ref('TodayStatus')), errs: [400, 401, 409, 422],
        extra: { description: 'Rejected with 422 `outside_location`, `no_location_assigned` or `mock_location`; 409 `already_checked_in`.' },
      }),
    },
    '/api/mobile/attendance/check-out': { post: op(M, 'Check out at one of the assigned locations', { requestBody: body(position), response: ok(ref('TodayStatus')), errs: [400, 401, 409, 422] }) },
    '/api/mobile/attendance/history': { get: op(M, 'Monthly attendance records and summary', { params: [q('month', { type: 'string', example: '2026-10' })] }) },
    '/api/mobile/requests': {
      get: op(M, 'Own requests', { params: [q('status', { type: 'string', enum: ['pending', 'approved', 'rejected', 'cancelled', 'previous'] }), q('type')], response: ok(listOf('Request')) }),
      post: op(M, 'Submit a request', { requestBody: body(ref('RequestInput')), response: ok(ref('Request')), errs: [400, 401, 409, 422] }),
    },
    '/api/mobile/requests/leave-balance': { get: op(M, 'Leave balances for a year', { params: [q('year', { type: 'string', example: '2026' })] }) },
    '/api/mobile/requests/{id}': {
      get: op(M, 'One own request', { params: [idParam()], response: ok(ref('Request')), errs: [401, 404] }),
      delete: op(M, 'Cancel a pending own request', { params: [idParam()], errs: [401, 404, 409] }),
    },
    '/api/mobile/salary': { get: op(M, 'Published payslip (latest or for a month)', { params: [q('month', { type: 'string', example: '2026-09' })] }) },
    '/api/mobile/penalties-rewards': { get: op(M, 'Own penalties and rewards') },
    '/api/mobile/documents': { get: op(M, 'Own appointment documents', { response: ok(listOf('Document')) }) },
    '/api/mobile/documents/{id}/upload': {
      post: op(M, 'Upload a document file (PDF / image, max 10 MB)', {
        params: [idParam()], errs: [400, 401, 404, 409],
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
      }),
    },
    '/api/mobile/documents/{id}/file': { get: op(M, 'Download own document file', { params: [idParam()], response: { description: 'File' }, errs: [401, 404] }) },
    '/api/mobile/notifications': { get: op(M, 'Notifications') },
    '/api/mobile/notifications/read-all': { patch: op(M, 'Mark all notifications read') },
    '/api/mobile/notifications/{id}/read': { patch: op(M, 'Mark one notification read', { params: [idParam()] }) },
    '/api/mobile/team/requests': { get: op(`${M} – Team`, "Team's requests (default: pending)", { params: [q('status'), q('type')], response: ok(listOf('Request')) }) },
    '/api/mobile/team/requests/{id}/approve': { patch: op(`${M} – Team`, 'Approve a team request', { params: [idParam()], requestBody: body(ref('Review'), false), errs: [401, 403, 404, 409, 422] }) },
    '/api/mobile/team/requests/{id}/reject': { patch: op(`${M} – Team`, 'Reject a team request', { params: [idParam()], requestBody: body(ref('Review'), false), errs: [401, 403, 404, 409] }) },
    '/api/mobile/team/attendance': { get: op(`${M} – Team`, "Team's attendance board for a date", { params: [q('date', { type: 'string', format: 'date' })] }) },

    // ---------------- Dashboard ----------------
    '/api/admin/auth/login': { post: op(A, 'Dashboard log in (managers & team leaders)', { security: [], requestBody: body(ref('Login')), errs: [400, 401, 403] }) },
    '/api/admin/auth/me': { get: op(A, 'Current user', { response: ok(ref('User')) }) },
    '/api/admin/auth/password': { patch: op(A, 'Change own password', { requestBody: body({ type: 'object', properties: { current_password: { type: 'string' }, password: { type: 'string' } } }) }) },
    '/api/admin/overview': { get: op(A, "Today's counts, pending requests and 14-day check-in trend (scoped to the caller)") },
    '/api/admin/notifications': { get: op(A, 'Notifications') },
    '/api/admin/notifications/read-all': { patch: op(A, 'Mark all notifications read') },
    '/api/admin/users': {
      get: op(A, 'Employees (team leaders: their team only)', { params: [q('search'), q('role'), q('team_id', { type: 'integer' }), q('active', { type: 'string', enum: ['true', 'false'] })], response: ok(listOf('User')) }),
      post: op(A, 'Create employee (manager)', { requestBody: body(ref('UserInput')), response: ok(ref('User')), errs: [400, 401, 403, 409] }),
    },
    '/api/admin/users/{id}': {
      get: op(A, 'Employee with leave balances', { params: [idParam(), q('year')], response: ok(ref('User')), errs: [401, 403, 404] }),
      patch: op(A, 'Update employee (manager)', { params: [idParam()], requestBody: body(ref('UserInput')), response: ok(ref('User')), errs: [400, 401, 403, 404, 409] }),
      delete: op(A, 'Deactivate employee (manager)', { params: [idParam()], errs: [400, 401, 403, 404] }),
    },
    '/api/admin/users/{id}/locations': {
      put: op(A, 'Set the check-in locations of an employee (manager)', { params: [idParam()], requestBody: body({ type: 'object', properties: { location_ids: { type: 'array', items: { type: 'integer' }, example: [1, 3] } } }), errs: [400, 401, 403, 404] }),
    },
    '/api/admin/users/{id}/attendance': { get: op(A, "Employee's monthly attendance", { params: [idParam(), q('month')], errs: [401, 403, 404] }) },
    '/api/admin/teams': {
      get: op(A, 'Teams (team leaders: teams they lead)', { response: ok(listOf('Team')) }),
      post: op(A, 'Create team (manager)', { requestBody: body(ref('TeamInput')), response: ok(ref('Team')), errs: [400, 401, 403, 409] }),
    },
    '/api/admin/teams/{id}': {
      get: op(A, 'Team with members', { params: [idParam()], response: ok(ref('Team')), errs: [401, 403, 404] }),
      patch: op(A, 'Update team, leader and members (manager)', { params: [idParam()], requestBody: body(ref('TeamInput')), errs: [400, 401, 403, 404, 409] }),
      delete: op(A, 'Delete team (manager)', { params: [idParam()], errs: [401, 403, 404] }),
    },
    '/api/admin/locations': {
      get: op(A, 'Check-in locations', { response: ok(listOf('Location')) }),
      post: op(A, 'Create location (manager)', { requestBody: body(ref('LocationInput')), response: ok(ref('Location')) }),
    },
    '/api/admin/locations/{id}': {
      get: op(A, 'Location with assigned employees', { params: [idParam()], errs: [401, 404] }),
      patch: op(A, 'Update location (manager)', { params: [idParam()], requestBody: body(ref('LocationInput')), errs: [400, 401, 403, 404] }),
      delete: op(A, 'Delete location (manager)', { params: [idParam()], errs: [401, 403, 404] }),
    },
    '/api/admin/attendance': {
      get: op(A, 'Attendance records', { params: [q('from', { type: 'string', format: 'date' }), q('to', { type: 'string', format: 'date' }), q('user_id', { type: 'integer' }), q('team_id', { type: 'integer' }), q('late_only', { type: 'string', enum: ['true'] })], response: ok(listOf('AttendanceRecord')) }),
      put: op(A, 'Correct / create / remove a record (manager)', {
        requestBody: body({ type: 'object', required: ['user_id', 'work_date'], properties: { user_id: { type: 'integer' }, work_date: { type: 'string', format: 'date' }, check_in_time: { type: 'string', example: '09:05', description: 'Omit to delete the record' }, check_out_time: { type: 'string', example: '17:10' }, note: { type: 'string' } } }),
        errs: [400, 401, 403, 404],
      }),
    },
    '/api/admin/attendance/board': { get: op(A, 'Status of every employee for a date', { params: [q('date', { type: 'string', format: 'date' })] }) },
    '/api/admin/attendance/export': { get: op(A, 'Attendance records as CSV', { params: [q('from'), q('to'), q('user_id'), q('team_id'), q('late_only')], response: { description: 'CSV file', content: { 'text/csv': {} } } }) },
    '/api/admin/requests': {
      get: op(A, 'Requests (team leaders: their team only)', { params: [q('status'), q('type'), q('user_id', { type: 'integer' }), q('team_id', { type: 'integer' }), q('from'), q('to')], response: ok(listOf('Request')) }),
    },
    '/api/admin/requests/{id}/approve': { patch: op(A, 'Approve request', { params: [idParam()], requestBody: body(ref('Review'), false), response: ok(ref('Request')), errs: [401, 403, 404, 409, 422] }) },
    '/api/admin/requests/{id}/reject': { patch: op(A, 'Reject request', { params: [idParam()], requestBody: body(ref('Review'), false), response: ok(ref('Request')), errs: [401, 403, 404, 409] }) },

    '/api/admin/payslips': {
      get: op(`${A} – Payroll`, 'Payslips', { params: [q('month'), q('user_id', { type: 'integer' })], response: ok(listOf('Payslip')) }),
      put: op(`${A} – Payroll`, 'Create or update a payslip', { requestBody: body(ref('PayslipInput')), response: ok(ref('Payslip')) }),
    },
    '/api/admin/payslips/suggest': { get: op(`${A} – Payroll`, 'Suggested figures from attendance, requests and penalties/rewards', { params: [q('user_id', { type: 'integer' }), q('month')] }) },
    '/api/admin/payslips/generate': { post: op(`${A} – Payroll`, 'Create drafts for every active employee', { requestBody: body({ type: 'object', properties: { month: { type: 'string', example: '2026-10' } } }) }) },
    '/api/admin/payslips/publish': { post: op(`${A} – Payroll`, 'Publish all drafts of a month (employees are notified)', { requestBody: body({ type: 'object', properties: { month: { type: 'string', example: '2026-10' } } }) }) },
    '/api/admin/payslips/{id}': {
      get: op(`${A} – Payroll`, 'One payslip', { params: [idParam()], response: ok(ref('Payslip')), errs: [401, 403, 404] }),
      delete: op(`${A} – Payroll`, 'Delete payslip', { params: [idParam()], errs: [401, 403, 404] }),
    },
    '/api/admin/adjustments': {
      get: op(`${A} – Payroll`, 'Penalties & rewards', { params: [q('user_id'), q('kind'), q('from'), q('to')] }),
      post: op(`${A} – Payroll`, 'Add penalty / reward (employee is notified)', { requestBody: body(ref('Adjustment')) }),
    },
    '/api/admin/adjustments/{id}': { delete: op(`${A} – Payroll`, 'Delete penalty / reward', { params: [idParam()], errs: [401, 403, 404] }) },
    '/api/admin/documents': {
      get: op(A, 'Appointment documents (manager)', { params: [q('user_id'), q('status')], response: ok(listOf('Document')) }),
      post: op(A, 'Request an extra document from an employee (manager)', { requestBody: body({ type: 'object', properties: { user_id: { type: 'integer' }, title: { type: 'string' } } }), errs: [400, 401, 403, 404, 409] }),
    },
    '/api/admin/documents/{id}': {
      patch: op(A, 'Review a document (manager)', { params: [idParam()], requestBody: body({ type: 'object', properties: { status: { type: 'string', enum: ['approved', 'rejected', 'missing'] }, note: { type: 'string' } } }), errs: [400, 401, 403, 404] }),
      delete: op(A, 'Delete a document (manager)', { params: [idParam()], errs: [401, 403, 404] }),
    },
    '/api/admin/documents/{id}/file': { get: op(A, 'Download a document file (manager)', { params: [idParam()], response: { description: 'File' }, errs: [401, 403, 404] }) },
    '/api/admin/settings': {
      get: op(`${A} – Settings`, 'Settings', { response: ok(ref('Settings')) }),
      patch: op(`${A} – Settings`, 'Update settings (manager)', { requestBody: body(ref('Settings')), response: ok(ref('Settings')) }),
    },
    '/api/admin/holidays': {
      get: op(`${A} – Settings`, 'Public holidays', { params: [q('year')] }),
      put: op(`${A} – Settings`, 'Add / rename a holiday (manager)', { requestBody: body({ type: 'object', properties: { date: { type: 'string', format: 'date' }, name: { type: 'string' } } }) }),
    },
    '/api/admin/holidays/{date}': { delete: op(`${A} – Settings`, 'Delete a holiday (manager)', { params: [{ name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }] }) },
  },
};
