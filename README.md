# Ilm HR API (Express + MariaDB)

## Setup

1. **Create a database user.** You need a MariaDB 10.6+ or MySQL 8 server. The API creates the database and tables itself on first start.
   ```sql
   CREATE USER 'ilm_hr'@'localhost' IDENTIFIED BY 'a-strong-password';
   GRANT ALL PRIVILEGES ON ilm_hr.* TO 'ilm_hr'@'localhost';
   GRANT ALL PRIVILEGES ON ilm_hr_test.* TO 'ilm_hr'@'localhost';   -- only needed for `npm test`
   ```
2. **Configure and run.**
   ```bash
   npm install
   cp .env.example .env   # set DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME and JWT_SECRET
   npm run migrate        # optional: create the database and tables only (no demo data). Safe to re-run.
   npm run dev            # http://localhost:4000 – creates the tables and seeds demo data on an empty database
   npm test               # runs against a separate database: ilm_hr_test
   npm run seed           # wipe & re-seed demo data
   ```

**API docs:** Swagger UI is at **`/api/docs`**, and the raw OpenAPI JSON is at `/api/docs.json`. Click *Authorize* and paste a token from one of the login endpoints. A test fails if any route is missing from the docs (`src/docs/openapi.js`).

### Creating users

- **First manager on a fresh server:**
  ```bash
  npm run create-user -- --name "Full Name" --email you@company.com --password "a-strong-password" --role manager
  ```
- **Everyone else:** a manager adds them on the dashboard (**Employees → Add employee**) or calls `POST /api/admin/users`.

### Push notifications (Firebase)

Every in-app notification is also sent as a push notification, which Android and iOS show even when the app is closed. Texts are in the employee's language (`ar`/`en`, reported by the app when it registers).

1. In the Firebase console (project **ilm-hr**), open **Project settings → Service accounts → Generate new private key**.
2. Copy the JSON file to the server (e.g. `secrets/firebase-service-account.json`, never commit it), and set `FIREBASE_SERVICE_ACCOUNT=/full/path/to/that.json` in `.env`.
3. Restart the API. The log shows `Push notifications: Firebase Cloud Messaging enabled`. Without the key, pushes are silently skipped and in-app notifications still work.
4. **iOS only:** in Firebase → Project settings → Cloud Messaging, upload an APNs authentication key (`.p8`) from your Apple Developer account.

### Moving data from the old SQLite version

```bash
SQLITE_FILE=./data/hr.sqlite npm run migrate:sqlite            # into an empty MariaDB database
SQLITE_FILE=./data/hr.sqlite npm run migrate:sqlite -- --force # replace existing MariaDB data
```

### Notes on the database

- **Timestamps:** stored in UTC (`DATETIME(3)`) and returned as ISO strings (`2026-10-12T06:43:03.000Z`). Dates are returned as `YYYY-MM-DD`. Business rules use the company time zone from the settings.
- **Encoding:** all tables use `utf8mb4`, so Arabic names are stored correctly.
- **Transactions:** run through `tx()` in `src/db/index.js`. Any query made inside it uses the same connection automatically.

Every response uses the envelope the Flutter app already models:
`{ "status": 200, "message": "...", "data": ... }`. Errors look like `{ "status": 4xx, "message": "...", "code": "..." }`.
All routes except login need `Authorization: Bearer <token>`.

## Layout

```
src/
  app.js, server.js, config.js
  db/        index.js (MariaDB pool, query helpers, tx), schema.js, seed.js, migrate-sqlite.js
  docs/      openapi.js (Swagger / OpenAPI spec)
  middleware/auth.js (JWT, role guards), upload.js (multer)
  services/  business rules – access.js holds the manager / team-leader scoping
  routes/    mobile.js (/api/mobile), admin.js (/api/admin)
  utils/     validation, geo (haversine), time-zone helpers
```

## Mobile API — `/api/mobile`

| Method | Path | Notes |
|---|---|---|
| POST | `/employees/login` | any active user; returns `{data:{id,name,email,national_id,type,role}, token}` |
| POST | `/managers/login` | team leaders & managers only (`type: 2`) |
| GET | `/employees/profile/get-user` | |
| PATCH | `/employees/profile/update` | `name, email, national_id, phone` |
| PATCH | `/employees/profile/update-password` | `current_password, password, password_confirmation` |
| GET | `/employees/dashboard` | profile card, month attendance, leave balances, request counts, documents |
| GET | `/attendance/today` | status, `can_check_in`, `can_check_out`, assigned locations |
| POST | `/attendance/check-in` · `/attendance/check-out` | `{latitude, longitude, accuracy?, is_mocked?}`; 422 `outside_location` / `no_location_assigned` / `mock_location`, 409 `already_checked_in` … |
| GET | `/attendance/history?month=YYYY-MM` | |
| GET | `/requests?status=pending\|approved\|rejected\|cancelled\|previous&type=` | |
| POST | `/requests` | see request bodies below |
| GET/DELETE | `/requests/:id` | DELETE cancels a pending request |
| GET | `/requests/leave-balance` | |
| GET | `/salary?month=YYYY-MM` | published payslips only |
| GET | `/penalties-rewards` | |
| GET | `/documents` · POST `/documents/:id/upload` (multipart `file`) · GET `/documents/:id/file` | |
| GET | `/notifications` · PATCH `/notifications/:id/read` · PATCH `/notifications/read-all` | |
| GET | `/team/requests` · PATCH `/team/requests/:id/approve\|reject` · GET `/team/attendance` | team leaders & managers |

Request bodies (`type` is required):

| type | fields |
|---|---|
| `leave` | `leave_type` (annual\|casual\|sick\|unpaid), `start_date`, `end_date`, `reason?` |
| `mission` | `start_date`, `end_date`, `destination`, `reason?` |
| `allowance` | `amount`, `reason`, `start_date?` |
| `early_leave` | `start_date`, `start_time` (HH:MM), `reason?` |
| `overtime` | `start_date`, `hours`, `reason?` |
| `complaint` | `reason` |

Leave and mission days are counted in working days (weekends and holidays excluded). Annual and casual leave cannot exceed the remaining balance; pending requests reserve days.

## Dashboard API — `/api/admin` (managers & team leaders)

`POST /auth/login`, `GET /auth/me`, `PATCH /auth/password`, `GET /overview`,
`GET/POST /users`, `GET/PATCH/DELETE /users/:id` (DELETE deactivates), `PUT /users/:id/locations`, `GET /users/:id/attendance`,
`GET/POST /teams`, `GET/PATCH/DELETE /teams/:id`,
`GET/POST /locations`, `GET/PATCH/DELETE /locations/:id`,
`GET /attendance`, `GET /attendance/board`, `GET /attendance/export` (CSV), `PUT /attendance` (manual correction),
`GET /requests`, `PATCH /requests/:id/approve|reject`,
`GET /payslips`, `GET /payslips/suggest`, `PUT /payslips`, `POST /payslips/generate|publish`, `DELETE /payslips/:id`,
`GET/POST /adjustments`, `DELETE /adjustments/:id`,
`GET/POST /documents`, `PATCH/DELETE /documents/:id`, `GET /documents/:id/file`,
`GET/PATCH /settings`, `GET/PUT /holidays`, `DELETE /holidays/:date`.

`GET /overview` includes `period.employees`, with separate statistics for each active employee visible to the caller. It defaults to the current month through today in the company time zone; pass `?from=YYYY-MM-DD&to=YYYY-MM-DD` for an inclusive custom range of up to 366 days. Each row has `worked_hours`, `average_hours_per_day`, `attendance_days`, `absent_days`, `late_days`, `excused_days`, and `attendance_rate`. Worked hours sum completed shifts after recorded breaks. Average hours per day divides those hours by completed shifts, so an open check-in does not lower the average. Absences count completed scheduled workdays without a check-in or approved leave/mission, starting on the employee's hire date. Holidays and each employee's weekend schedule are respected. Attendance rate is attended divided by expected completed workdays after excused days are removed.

Write operations are manager-only, except approving/rejecting requests. Every list endpoint is automatically scoped to the caller's team(s) for team leaders.
