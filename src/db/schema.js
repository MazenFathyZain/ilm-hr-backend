// MariaDB / MySQL schema. Statements are idempotent and applied in order by initDb().
// Dates are DATE columns (returned as 'YYYY-MM-DD' strings) and timestamps are UTC DATETIME(3)
// columns (returned as ISO strings ending in 'Z') – see the typeCast in db/index.js.

const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
    \`key\` VARCHAR(64) NOT NULL PRIMARY KEY,
    value   TEXT NOT NULL
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS users (
    id                   INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    employee_code        VARCHAR(50) NULL UNIQUE,
    name                 VARCHAR(150) NOT NULL,
    email                VARCHAR(190) NOT NULL UNIQUE,
    password_hash        VARCHAR(100) NOT NULL,
    national_id          VARCHAR(30) NULL,
    phone                VARCHAR(40) NULL,
    job_title            VARCHAR(150) NULL,
    branch               VARCHAR(150) NULL,
    role                 ENUM('manager','team_leader','employee') NOT NULL DEFAULT 'employee',
    team_id              INT UNSIGNED NULL,
    hire_date            DATE NULL,
    basic_salary         DECIMAL(12,2) NOT NULL DEFAULT 0,
    annual_leave_balance SMALLINT UNSIGNED NOT NULL DEFAULT 21,
    casual_leave_balance SMALLINT UNSIGNED NOT NULL DEFAULT 7,
    is_active            TINYINT(1) NOT NULL DEFAULT 1,
    avatar_path          VARCHAR(255) NULL,
    created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_users_team (team_id)
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS teams (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(150) NOT NULL UNIQUE,
    description VARCHAR(500) NULL,
    leader_id   INT UNSIGNED NULL,
    created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_teams_leader FOREIGN KEY (leader_id) REFERENCES users(id) ON DELETE SET NULL
  ) ${TABLE_OPTS}`,

  // users <-> teams reference each other, so this FK is added once both tables exist (see initDb).

  `CREATE TABLE IF NOT EXISTS locations (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(150) NOT NULL,
    address       VARCHAR(300) NULL,
    latitude      DOUBLE NOT NULL,
    longitude     DOUBLE NOT NULL,
    radius_meters INT UNSIGNED NOT NULL DEFAULT 100,
    is_active     TINYINT(1) NOT NULL DEFAULT 1,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS user_locations (
    user_id     INT UNSIGNED NOT NULL,
    location_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (user_id, location_id),
    CONSTRAINT fk_ul_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_ul_location FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS attendance (
    id                    INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id               INT UNSIGNED NOT NULL,
    work_date             DATE NOT NULL,
    check_in_at           DATETIME(3) NULL,
    check_in_location_id  INT UNSIGNED NULL,
    check_in_lat          DOUBLE NULL,
    check_in_lng          DOUBLE NULL,
    check_out_at          DATETIME(3) NULL,
    check_out_location_id INT UNSIGNED NULL,
    check_out_lat         DOUBLE NULL,
    check_out_lng         DOUBLE NULL,
    late_minutes          INT UNSIGNED NOT NULL DEFAULT 0,
    check_out_method      ENUM('manual','left_location','admin') NULL,
    last_ping_at          DATETIME(3) NULL,
    note                  VARCHAR(500) NULL,
    edited_by             INT UNSIGNED NULL,
    UNIQUE KEY uq_attendance_user_date (user_id, work_date),
    KEY idx_attendance_date (work_date),
    CONSTRAINT fk_att_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_att_in_loc FOREIGN KEY (check_in_location_id) REFERENCES locations(id) ON DELETE SET NULL,
    CONSTRAINT fk_att_out_loc FOREIGN KEY (check_out_location_id) REFERENCES locations(id) ON DELETE SET NULL,
    CONSTRAINT fk_att_editor FOREIGN KEY (edited_by) REFERENCES users(id) ON DELETE SET NULL
  ) ${TABLE_OPTS}`,

  // Time an employee spent outside their assigned locations after checking in
  // (they are checked out automatically when they leave and can check in again when they return).
  `CREATE TABLE IF NOT EXISTS attendance_breaks (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    attendance_id INT UNSIGNED NOT NULL,
    left_at       DATETIME(3) NOT NULL,
    returned_at   DATETIME(3) NULL,
    left_lat      DOUBLE NULL,
    left_lng      DOUBLE NULL,
    KEY idx_breaks_attendance (attendance_id),
    CONSTRAINT fk_break_attendance FOREIGN KEY (attendance_id) REFERENCES attendance(id) ON DELETE CASCADE
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS requests (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id     INT UNSIGNED NOT NULL,
    type        ENUM('leave','allowance','mission','early_leave','overtime','complaint') NOT NULL,
    leave_type  ENUM('annual','casual','sick','unpaid') NULL,
    start_date  DATE NULL,
    end_date    DATE NULL,
    days        SMALLINT UNSIGNED NULL,
    start_time  CHAR(5) NULL,
    end_time    CHAR(5) NULL,
    hours       DECIMAL(5,2) NULL,
    amount      DECIMAL(12,2) NULL,
    destination VARCHAR(300) NULL,
    reason      TEXT NULL,
    status      ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
    reviewer_id INT UNSIGNED NULL,
    review_note TEXT NULL,
    reviewed_at DATETIME(3) NULL,
    created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_requests_user (user_id, status),
    CONSTRAINT fk_req_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_req_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS adjustments (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    INT UNSIGNED NOT NULL,
    kind       ENUM('penalty','reward') NOT NULL,
    amount     DECIMAL(12,2) NOT NULL DEFAULT 0,
    reason     VARCHAR(500) NOT NULL,
    date       DATE NOT NULL,
    created_by INT UNSIGNED NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_adj_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_adj_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS payslips (
    id               INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id          INT UNSIGNED NOT NULL,
    month            CHAR(7) NOT NULL,
    basic_salary     DECIMAL(12,2) NOT NULL DEFAULT 0,
    earnings         TEXT NOT NULL,
    deductions       TEXT NOT NULL,
    total_earnings   DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_deductions DECIMAL(12,2) NOT NULL DEFAULT 0,
    net_salary       DECIMAL(12,2) NOT NULL DEFAULT 0,
    status           ENUM('draft','published') NOT NULL DEFAULT 'draft',
    updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_payslip_user_month (user_id, month),
    CONSTRAINT fk_pay_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS documents (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id       INT UNSIGNED NOT NULL,
    title         VARCHAR(190) NOT NULL,
    status        ENUM('missing','submitted','approved','rejected') NOT NULL DEFAULT 'missing',
    file_path     VARCHAR(255) NULL,
    original_name VARCHAR(255) NULL,
    mime_type     VARCHAR(100) NULL,
    note          VARCHAR(500) NULL,
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_document_user_title (user_id, title),
    CONSTRAINT fk_doc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    INT UNSIGNED NOT NULL,
    title      VARCHAR(255) NOT NULL,
    body       TEXT NULL,
    is_read    TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_notifications_user (user_id, is_read),
    CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ${TABLE_OPTS}`,

  // Firebase Cloud Messaging tokens – one row per installed app.
  `CREATE TABLE IF NOT EXISTS device_tokens (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    INT UNSIGNED NOT NULL,
    token      VARCHAR(255) NOT NULL UNIQUE,
    platform   ENUM('android','ios','web') NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_device_tokens_user (user_id),
    CONSTRAINT fk_device_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS holidays (
    date DATE NOT NULL PRIMARY KEY,
    name VARCHAR(150) NOT NULL
  ) ${TABLE_OPTS}`,
];

/** Columns added after the first MariaDB release – applied to existing databases by initDb(). */
export const MIGRATIONS = [
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_path VARCHAR(255) NULL AFTER is_active',
  "ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_out_method ENUM('manual','left_location','admin') NULL AFTER late_minutes",
  'ALTER TABLE attendance ADD COLUMN IF NOT EXISTS last_ping_at DATETIME(3) NULL AFTER check_out_method',
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS locale ENUM('ar','en') NOT NULL DEFAULT 'ar' AFTER avatar_path",
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type VARCHAR(40) NULL AFTER user_id',
  'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data TEXT NULL AFTER body',
];

/** Tables in an order that is safe for deleting/copying with FK checks on. */
export const TABLES = ['settings', 'holidays', 'users', 'teams', 'locations', 'user_locations', 'attendance', 'attendance_breaks', 'requests',
  'adjustments', 'payslips', 'documents', 'notifications', 'device_tokens'];
