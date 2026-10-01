-- Up Migration
-- =====================================================================
-- Shift Scheduler & Attendance: schema v2.3 (migration 0001_init)
-- PostgreSQL 15+. BIGINT identity PKs, snake_case, TIMESTAMPTZ, soft delete
-- via deleted_at, tenant integrity via composite (id, hotel_id) FKs.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ---------- tenancy ----------
CREATE TABLE companies (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE hotels (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id               BIGINT NOT NULL REFERENCES companies(id),
  name                     TEXT NOT NULL,
  city                     TEXT,
  timezone                 TEXT NOT NULL DEFAULT 'Europe/Berlin',
  holiday_region           TEXT NOT NULL DEFAULT 'DE-HE',   -- public holidays via date-holidays
  attendance_locked_until  DATE,                            -- payroll lock: entries on/before are frozen
  settings                 JSONB NOT NULL DEFAULT '{}'::jsonb,  -- legal + attendance parameters, see spec section 4
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  CONSTRAINT uq_hotels_id_company UNIQUE (id, company_id)
);
CREATE INDEX idx_hotels_company ON hotels(company_id) WHERE deleted_at IS NULL;

-- ---------- structure ----------
CREATE TABLE departments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hotel_id    BIGINT NOT NULL REFERENCES hotels(id),
  name        TEXT NOT NULL,
  color       TEXT CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT uq_departments_id_hotel UNIQUE (id, hotel_id)
);
CREATE UNIQUE INDEX uq_departments_hotel_name
  ON departments(hotel_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE shifts (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hotel_id                BIGINT NOT NULL,
  department_id           BIGINT NOT NULL,
  name                    TEXT NOT NULL,
  start_time              TIME NOT NULL,
  end_time                TIME NOT NULL,
  break_duration_minutes  INT NOT NULL DEFAULT 0,
  -- wraps midnight automatically (22:00-06:00 = 480)
  duration_minutes        INT GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (end_time - start_time))::int / 60
    + CASE WHEN end_time > start_time THEN 0 ELSE 1440 END
  ) STORED,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ,
  CONSTRAINT uq_shifts_id_hotel UNIQUE (id, hotel_id),
  CONSTRAINT fk_shifts_department FOREIGN KEY (department_id, hotel_id)
    REFERENCES departments(id, hotel_id),
  CONSTRAINT chk_shift_times CHECK (start_time <> end_time),
  CONSTRAINT chk_shift_break CHECK (break_duration_minutes >= 0
    AND break_duration_minutes < duration_minutes)
);
CREATE UNIQUE INDEX uq_shifts_dept_name
  ON shifts(hotel_id, department_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_shifts_hotel_dept ON shifts(hotel_id, department_id) WHERE deleted_at IS NULL;

CREATE TABLE shift_staffing_requirements (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hotel_id    BIGINT NOT NULL,
  shift_id    BIGINT NOT NULL,
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),  -- ISO: 1=Mon
  min_staff   INT NOT NULL CHECK (min_staff >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shift_id, weekday),
  FOREIGN KEY (shift_id, hotel_id) REFERENCES shifts(id, hotel_id)
);

-- ---------- people ----------
CREATE TABLE employees (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     BIGINT NOT NULL REFERENCES companies(id),
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  email          TEXT,
  phone          TEXT,
  hourly_rate    NUMERIC(8,2) CHECK (hourly_rate >= 0),
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','on_leave','terminated')),   -- on_leave is informational only
  work_weekdays  SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}'::smallint[],  -- ISO weekdays the employee normally works
  terminated_on  DATE,
  anonymized_at  TIMESTAMPTZ,
  employee_number     TEXT,                                  -- Personalnummer, unique per company
  birth_date          DATE,                                  -- needed for youth-protection rules; restricted read access
  hired_on            DATE,
  employment_type     TEXT NOT NULL DEFAULT 'full_time'
                      CHECK (employment_type IN ('full_time','part_time','mini_job','working_student','apprentice','intern','other')),
  attendance_required BOOLEAN NOT NULL DEFAULT true,         -- false: no no-show flags (e.g. salaried managers)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  CONSTRAINT uq_employees_id_company UNIQUE (id, company_id),
  CONSTRAINT chk_work_weekdays CHECK (
    work_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[] AND cardinality(work_weekdays) >= 1)
);
CREATE INDEX idx_employees_company ON employees(company_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_employees_number ON employees(company_id, employee_number)
  WHERE employee_number IS NOT NULL AND deleted_at IS NULL;

-- which hotels an employee may work at (floating staff = several rows). Exactly one home hotel (service rule + unique index).
-- Rows are never deleted once used: unassigning sets unassigned_on, so history keeps its references.
CREATE TABLE employee_hotels (
  employee_id    BIGINT NOT NULL,
  hotel_id       BIGINT NOT NULL,
  company_id     BIGINT NOT NULL,
  is_home        BOOLEAN NOT NULL DEFAULT false,
  assigned_on    DATE NOT NULL DEFAULT CURRENT_DATE,
  unassigned_on  DATE,
  PRIMARY KEY (employee_id, hotel_id),
  FOREIGN KEY (employee_id, company_id) REFERENCES employees(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (hotel_id, company_id)    REFERENCES hotels(id, company_id),
  CHECK (unassigned_on IS NULL OR unassigned_on >= assigned_on),
  CHECK (NOT (is_home AND unassigned_on IS NOT NULL))
);
CREATE UNIQUE INDEX uq_one_home_hotel ON employee_hotels(employee_id) WHERE is_home;
CREATE INDEX idx_employee_hotels_hotel ON employee_hotels(hotel_id) WHERE unassigned_on IS NULL;

CREATE TABLE employee_departments (
  employee_id    BIGINT NOT NULL,
  department_id  BIGINT NOT NULL,
  hotel_id       BIGINT NOT NULL,
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, department_id),
  FOREIGN KEY (employee_id, hotel_id)   REFERENCES employee_hotels(employee_id, hotel_id) ON DELETE CASCADE,
  FOREIGN KEY (department_id, hotel_id) REFERENCES departments(id, hotel_id)
);

-- kiosk PIN, kept apart so employee reads never touch the hash
CREATE TABLE employee_pins (
  employee_id   BIGINT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  pin_hash      TEXT NOT NULL,
  failed_count  INT NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  set_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employee_work_targets (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id             BIGINT NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  target_hours_per_week   NUMERIC(5,1) NOT NULL DEFAULT 40.0,
  min_hours_per_week      NUMERIC(5,1) NOT NULL DEFAULT 30.0,
  max_hours_per_week      NUMERIC(5,1) NOT NULL DEFAULT 50.0,
  target_hours_per_month  NUMERIC(6,1) NOT NULL DEFAULT 160.0,
  min_hours_per_month     NUMERIC(6,1) NOT NULL DEFAULT 130.0,
  max_hours_per_month     NUMERIC(6,1) NOT NULL DEFAULT 220.0,
  opening_balance_hours   NUMERIC(6,1) NOT NULL DEFAULT 0,   -- time account (Arbeitszeitkonto) start value
  balance_start_date      DATE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (min_hours_per_week <= target_hours_per_week AND target_hours_per_week <= max_hours_per_week),
  CHECK (min_hours_per_month <= target_hours_per_month AND target_hours_per_month <= max_hours_per_month)
);

-- "used" days are DERIVED (view v_vacation_usage below), never a stored counter
CREATE TABLE employee_vacation_allowance (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id             BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  year                    INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  vacation_days_per_year  NUMERIC(4,1) NOT NULL DEFAULT 30.0 CHECK (vacation_days_per_year >= 0),
  carried_over_days       NUMERIC(4,1) NOT NULL DEFAULT 0 CHECK (carried_over_days >= 0),
  carry_over_expires_on   DATE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, year)
);

-- ---------- auth & access ----------
CREATE TABLE users (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id         BIGINT NOT NULL REFERENCES companies(id),
  employee_id        BIGINT REFERENCES employees(id),       -- staff logins point at their employee
  email              TEXT,                                  -- optional: staff without e-mail log in with a username
  username           TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'de' CHECK (preferred_language ~ '^[a-z]{2}$'),
  password_hash      TEXT,                                  -- NULL until the invite is accepted
  role               TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff','manager','admin')),
  first_name         TEXT,
  last_name          TEXT,
  status             TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')),
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until       TIMESTAMPTZ,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT chk_staff_employee CHECK (role <> 'staff' OR employee_id IS NOT NULL),
  CONSTRAINT chk_login_identifier CHECK (email IS NOT NULL OR username IS NOT NULL),
  CONSTRAINT chk_username_format CHECK (username IS NULL OR username ~ '^[a-z0-9._]{3,40}$'),
  CONSTRAINT chk_active_has_password CHECK (status <> 'active' OR password_hash IS NOT NULL)
);
CREATE UNIQUE INDEX uq_users_email ON users(lower(email)) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE UNIQUE INDEX uq_users_username ON users(username) WHERE deleted_at IS NULL AND username IS NOT NULL;

-- manager = 1 row (hotel manager) or many rows (regional manager); admin = company-wide, no rows needed;
-- staff access is derived from their employee's hotel. Service rule: a manager needs >= 1 row.
CREATE TABLE user_hotel_access (
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hotel_id  BIGINT NOT NULL REFERENCES hotels(id),
  PRIMARY KEY (user_id, hotel_id)
);
CREATE INDEX idx_user_hotel_access_hotel ON user_hotel_access(hotel_id);

CREATE TABLE user_tokens (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('invite','password_reset')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_tokens_user ON user_tokens(user_id);

CREATE TABLE refresh_tokens (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id       UUID NOT NULL DEFAULT gen_random_uuid(),   -- one login session; reuse of a rotated token revokes the family
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  replaced_by_id  BIGINT,
  user_agent      TEXT,
  ip              TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_family ON refresh_tokens(family_id);

-- ---------- absences ----------
-- Planned days off ("Frei") are NOT absences: they are roster entries (schedules.entry_type = 'off').
CREATE TABLE time_offs (
  id                           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id                  BIGINT NOT NULL REFERENCES employees(id),
  start_date                   DATE NOT NULL,
  end_date                     DATE NOT NULL,
  start_half_day               BOOLEAN NOT NULL DEFAULT false,
  end_half_day                 BOOLEAN NOT NULL DEFAULT false,
  time_off_days                NUMERIC(4,1) NOT NULL CHECK (time_off_days >= 0),  -- COMPUTED by the server (see time_off_dates)
  type                         TEXT NOT NULL CHECK (type IN ('annual_leave','sick_leave','unpaid_leave','school','other')),
  reason                       TEXT,   -- NEVER stored for sick_leave (health data)
  status                       TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','approved','rejected','cancelled')),
  medical_certificate_received BOOLEAN NOT NULL DEFAULT false,
  created_by_id                BIGINT REFERENCES users(id),
  decided_by_id                BIGINT REFERENCES users(id),
  decided_at                   TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (time_off_days <= (end_date - start_date) + 1),
  CHECK (type <> 'sick_leave' OR reason IS NULL),
  -- leave/unpaid/other may not overlap each other ...
  CONSTRAINT no_overlapping_time_offs EXCLUDE USING gist (
    employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status IN ('pending','approved') AND type <> 'sick_leave'),
  -- ... sick leave may overlap vacation (certified sick days refund vacation) but not other sick leave
  CONSTRAINT no_overlapping_sick_leave EXCLUDE USING gist (
    employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status IN ('pending','approved') AND type = 'sick_leave')
);
CREATE INDEX idx_time_offs_emp_dates ON time_offs(employee_id, start_date, end_date);

-- one row per counted day: weekends/non-working weekdays/public holidays are skipped by the server
CREATE TABLE time_off_dates (
  time_off_id  BIGINT NOT NULL REFERENCES time_offs(id) ON DELETE CASCADE,
  employee_id  BIGINT NOT NULL,
  date         DATE NOT NULL,
  day_fraction NUMERIC(2,1) NOT NULL CHECK (day_fraction IN (0.5, 1.0)),
  PRIMARY KEY (time_off_id, date)
);
CREATE INDEX idx_time_off_dates_emp ON time_off_dates(employee_id, date);

-- vacation days used/pending per employee and year; certified sick days inside vacation do not count
CREATE VIEW v_vacation_usage AS
SELECT d.employee_id,
       EXTRACT(YEAR FROM d.date)::int AS year,
       t.status,
       SUM(d.day_fraction) AS days
FROM time_off_dates d
JOIN time_offs t ON t.id = d.time_off_id
WHERE t.type = 'annual_leave' AND t.status IN ('pending','approved')
  AND NOT EXISTS (
    SELECT 1 FROM time_off_dates sd JOIN time_offs st ON st.id = sd.time_off_id
    WHERE sd.employee_id = d.employee_id AND sd.date = d.date
      AND st.type = 'sick_leave' AND st.status = 'approved' AND st.medical_certificate_received)
GROUP BY d.employee_id, EXTRACT(YEAR FROM d.date), t.status;

-- leave blackout periods (e.g. trade-fair weeks): warn or block annual-leave requests
CREATE TABLE leave_blackouts (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hotel_id       BIGINT NOT NULL REFERENCES hotels(id),
  start_date     DATE NOT NULL,
  end_date       DATE NOT NULL,
  reason         TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'warn' CHECK (mode IN ('warn','block')),
  created_by_id  BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  CHECK (end_date >= start_date)
);
CREATE INDEX idx_blackouts_hotel ON leave_blackouts(hotel_id, start_date, end_date) WHERE deleted_at IS NULL;

-- ---------- roster ----------
CREATE TABLE schedules (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hotel_id        BIGINT NOT NULL,
  employee_id     BIGINT NOT NULL,
  entry_type      TEXT NOT NULL DEFAULT 'shift' CHECK (entry_type IN ('shift','off')),
  shift_id        BIGINT,                              -- NULL for 'off' entries (0 hours)
  off_label       TEXT,                                -- e.g. 'Frei', 'Wunschfrei'
  date            DATE NOT NULL,                       -- hotel-local; "no past dates" is a SERVICE rule
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at    TIMESTAMPTZ,
  published_by_id BIGINT REFERENCES users(id),
  warnings        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- snapshot of soft warnings at save time
  override_reason TEXT,
  created_by_id   BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- no per-day uniqueness: split shifts are allowed; overlaps and day-off exclusivity are enforced by trg_schedule_checks
  FOREIGN KEY (employee_id, hotel_id) REFERENCES employee_hotels(employee_id, hotel_id),
  FOREIGN KEY (shift_id, hotel_id)    REFERENCES shifts(id, hotel_id),
  CONSTRAINT chk_entry_shape CHECK (
    (entry_type = 'shift' AND shift_id IS NOT NULL AND off_label IS NULL) OR
    (entry_type = 'off'   AND shift_id IS NULL)),
  CONSTRAINT chk_published_fields CHECK ((status = 'published') = (published_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_schedule_same_shift ON schedules(employee_id, date, shift_id) WHERE entry_type = 'shift';
CREATE UNIQUE INDEX uq_schedule_one_off    ON schedules(employee_id, date)           WHERE entry_type = 'off';
CREATE INDEX idx_schedules_hotel_date ON schedules(hotel_id, date);
CREATE INDEX idx_schedules_status     ON schedules(hotel_id, status, date);
CREATE INDEX idx_schedules_shift_date ON schedules(shift_id, date);
CREATE INDEX idx_schedules_emp_date   ON schedules(employee_id, date);

-- an employee must be ASSIGNED to the hotel (and not unassigned before the entry date)
CREATE OR REPLACE FUNCTION employee_active_at_hotel(emp BIGINT, hot BIGINT, d DATE) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM employee_hotels eh
                 WHERE eh.employee_id = emp AND eh.hotel_id = hot
                   AND (eh.unassigned_on IS NULL OR eh.unassigned_on >= d));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION check_roster_entry() RETURNS trigger AS $$
DECLARE
  v_start timestamptz;
  v_end   timestamptz;
BEGIN
  -- serialise roster changes per employee (two managers, two hotels, same person)
  PERFORM pg_advisory_xact_lock(hashtextextended('roster:' || NEW.employee_id::text, 0));

  IF NOT employee_active_at_hotel(NEW.employee_id, NEW.hotel_id, NEW.date) THEN
    RAISE EXCEPTION 'Employee is not assigned to this hotel on that date' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.entry_type = 'off' THEN
    IF EXISTS (SELECT 1 FROM schedules o WHERE o.employee_id = NEW.employee_id AND o.date = NEW.date
                 AND o.id IS DISTINCT FROM NEW.id) THEN
      RAISE EXCEPTION 'Day off cannot coexist with another entry that day' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.shift_id IS NULL THEN RETURN NEW; END IF;   -- shape errors come from chk_entry_shape

  IF EXISTS (SELECT 1 FROM schedules o WHERE o.employee_id = NEW.employee_id AND o.date = NEW.date
               AND o.entry_type = 'off' AND o.id IS DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'Day off cannot coexist with another entry that day' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM shifts s
    JOIN employee_departments ed ON ed.department_id = s.department_id
    WHERE s.id = NEW.shift_id AND ed.employee_id = NEW.employee_id
  ) THEN
    RAISE EXCEPTION 'Employee does not work in this shift''s department' USING ERRCODE = 'check_violation';
  END IF;

  -- overlap with the employee's other shifts at ANY hotel, on real instants in each hotel's timezone
  SELECT (NEW.date + s.start_time) AT TIME ZONE h.timezone,
         (NEW.date + CASE WHEN s.end_time > s.start_time THEN 0 ELSE 1 END + s.end_time) AT TIME ZONE h.timezone
    INTO v_start, v_end
    FROM shifts s JOIN hotels h ON h.id = s.hotel_id
   WHERE s.id = NEW.shift_id;

  IF EXISTS (
    SELECT 1 FROM schedules o
    JOIN shifts os ON os.id = o.shift_id
    JOIN hotels oh ON oh.id = o.hotel_id
    WHERE o.employee_id = NEW.employee_id AND o.entry_type = 'shift'
      AND o.date BETWEEN NEW.date - 1 AND NEW.date + 1
      AND o.id IS DISTINCT FROM NEW.id
      AND tstzrange(v_start, v_end) &&
          tstzrange((o.date + os.start_time) AT TIME ZONE oh.timezone,
                    (o.date + CASE WHEN os.end_time > os.start_time THEN 0 ELSE 1 END + os.end_time) AT TIME ZONE oh.timezone)
  ) THEN
    RAISE EXCEPTION 'Shift overlaps another shift of the same employee' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_schedule_checks
  BEFORE INSERT OR UPDATE OF employee_id, hotel_id, shift_id, entry_type, date ON schedules
  FOR EACH ROW EXECUTE FUNCTION check_roster_entry();

-- ---------- wishes ----------
CREATE TABLE employee_shift_wishes (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hotel_id              BIGINT NOT NULL,
  employee_id           BIGINT NOT NULL,
  date                  DATE NOT NULL,
  shift_id              BIGINT,                         -- NULL + kind 'avoid' = "I want this day off" (Wunschfrei)
  kind                  TEXT NOT NULL DEFAULT 'prefer' CHECK (kind IN ('prefer','avoid')),
  priority              SMALLINT NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  reason                TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by_id         BIGINT REFERENCES users(id),
  decided_at            TIMESTAMPTZ,
  decision_note         TEXT,
  fulfilled_schedule_id BIGINT REFERENCES schedules(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (employee_id, hotel_id) REFERENCES employee_hotels(employee_id, hotel_id),
  FOREIGN KEY (shift_id, hotel_id)    REFERENCES shifts(id, hotel_id),
  CONSTRAINT chk_wish_shape CHECK (shift_id IS NOT NULL OR kind = 'avoid')
);
CREATE UNIQUE INDEX uq_shift_wish_pending
  ON employee_shift_wishes(employee_id, date, COALESCE(shift_id, 0)) WHERE status = 'pending';
CREATE INDEX idx_shift_wishes_hotel ON employee_shift_wishes(hotel_id, status, date);

CREATE OR REPLACE FUNCTION check_wish_assignment() RETURNS trigger AS $$
BEGIN
  IF NOT employee_active_at_hotel(NEW.employee_id, NEW.hotel_id, NEW.date) THEN
    RAISE EXCEPTION 'Employee is not assigned to this hotel on that date' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_wish_assignment BEFORE INSERT ON employee_shift_wishes
  FOR EACH ROW EXECUTE FUNCTION check_wish_assignment();

CREATE TABLE employee_leave_wishes (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id            BIGINT NOT NULL REFERENCES employees(id),
  start_date             DATE NOT NULL,
  end_date               DATE NOT NULL,
  leave_days             NUMERIC(4,1) NOT NULL CHECK (leave_days > 0),
  priority               SMALLINT NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  reason                 TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by_id          BIGINT REFERENCES users(id),
  decided_at             TIMESTAMPTZ,
  decision_note          TEXT,
  fulfilled_time_off_id  BIGINT REFERENCES time_offs(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CONSTRAINT no_overlapping_leave_wishes EXCLUDE USING gist (
    employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status IN ('pending','approved'))
);
CREATE INDEX idx_leave_wishes_emp ON employee_leave_wishes(employee_id, status, start_date);

-- ---------- employee portal: questions and notifications ----------
CREATE TABLE inquiries (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id      BIGINT NOT NULL REFERENCES employees(id),
  hotel_id         BIGINT NOT NULL REFERENCES hotels(id),   -- routing: the related entry's hotel, else the home hotel
  subject          TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 120),
  category         TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('roster','hours','vacation','attendance','other')),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  related_type     TEXT CHECK (related_type IN ('schedule','time_entry','time_off','shift_wish','leave_wish','correction')),
  related_id       BIGINT,
  assigned_to_id   BIGINT REFERENCES users(id),
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((related_type IS NULL) = (related_id IS NULL)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX idx_inquiries_hotel    ON inquiries(hotel_id, status, last_message_at DESC);
CREATE INDEX idx_inquiries_employee ON inquiries(employee_id, last_message_at DESC);

CREATE TABLE inquiry_messages (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inquiry_id      BIGINT NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  author_user_id  BIGINT NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_inquiry_messages ON inquiry_messages(inquiry_id, created_at);
CREATE OR REPLACE FUNCTION inquiry_messages_no_update() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'inquiry messages cannot be edited'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_inquiry_messages_no_update BEFORE UPDATE ON inquiry_messages
  FOR EACH ROW EXECUTE FUNCTION inquiry_messages_no_update();

-- in-app notifications; e-mail is optional and sent by a job (generic text + link, never health details)
CREATE TABLE notifications (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('roster_published','roster_entry_changed','roster_entry_removed',
                   'absence_decided','wish_decided','correction_decided','inquiry_reply','inquiry_new',
                   'absence_requested','wish_submitted','correction_requested','needs_review_entry','sick_reported')),
  params         JSONB NOT NULL DEFAULT '{}'::jsonb,       -- ids and dates only
  entity_type    TEXT,
  entity_id      BIGINT,
  urgent         BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at        TIMESTAMPTZ,
  email_due      BOOLEAN NOT NULL DEFAULT false,
  emailed_at     TIMESTAMPTZ,
  email_attempts INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_notifications_user   ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_email  ON notifications(created_at) WHERE email_due AND emailed_at IS NULL;

CREATE TABLE notification_preferences (
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,
  email    BOOLEAN NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- ---------- attendance (shared hotel tablet) ----------
CREATE TABLE kiosk_devices (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hotel_id       BIGINT NOT NULL REFERENCES hotels(id),
  name           TEXT NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,                  -- sha256 of the 256-bit device token
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_seen_at   TIMESTAMPTZ,
  created_by_id  BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX idx_kiosk_devices_hotel ON kiosk_devices(hotel_id);

CREATE TABLE kiosk_pairing_codes (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hotel_id       BIGINT NOT NULL REFERENCES hotels(id),
  device_name    TEXT NOT NULL,
  code_hash      TEXT NOT NULL UNIQUE,
  expires_at     TIMESTAMPTZ NOT NULL,                  -- 10 minutes
  used_at        TIMESTAMPTZ,
  created_by_id  BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server time only. Raw timestamps are never rounded or overwritten (changes go through corrections).
CREATE TABLE time_entries (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hotel_id       BIGINT NOT NULL,
  employee_id    BIGINT NOT NULL,
  schedule_id    BIGINT REFERENCES schedules(id) ON DELETE SET NULL,
  clock_in_at    TIMESTAMPTZ NOT NULL,
  clock_out_at   TIMESTAMPTZ,
  break_minutes  INT NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','needs_review')),
  source_in      TEXT NOT NULL CHECK (source_in IN ('kiosk','manager')),
  source_out     TEXT CHECK (source_out IN ('kiosk','manager')),
  device_in_id   BIGINT REFERENCES kiosk_devices(id),
  device_out_id  BIGINT REFERENCES kiosk_devices(id),
  anomalies      JSONB NOT NULL DEFAULT '[]'::jsonb,
  note           TEXT,
  created_by_id  BIGINT REFERENCES users(id),           -- set for manager-created entries
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (employee_id, hotel_id) REFERENCES employee_hotels(employee_id, hotel_id),
  CONSTRAINT chk_entry_times CHECK (clock_out_at IS NULL OR clock_out_at > clock_in_at),
  CONSTRAINT chk_entry_status CHECK (
    (status = 'closed' AND clock_out_at IS NOT NULL) OR
    (status IN ('open','needs_review') AND clock_out_at IS NULL)),
  CONSTRAINT chk_break_within CHECK (
    clock_out_at IS NULL OR break_minutes < EXTRACT(EPOCH FROM (clock_out_at - clock_in_at)) / 60),
  -- no overlapping entries; an open entry has an infinite upper bound, so only ONE open entry can exist
  CONSTRAINT no_overlapping_time_entries EXCLUDE USING gist (
    employee_id WITH =,
    tstzrange(clock_in_at, COALESCE(clock_out_at, 'infinity'::timestamptz)) WITH &&)
);
CREATE INDEX idx_time_entries_hotel_in ON time_entries(hotel_id, clock_in_at);
CREATE INDEX idx_time_entries_emp_in   ON time_entries(employee_id, clock_in_at);
CREATE INDEX idx_time_entries_status   ON time_entries(hotel_id, status) WHERE status <> 'closed';

CREATE OR REPLACE FUNCTION check_entry_assignment() RETURNS trigger AS $$
BEGIN
  IF NOT employee_active_at_hotel(NEW.employee_id, NEW.hotel_id, NEW.clock_in_at::date) THEN
    RAISE EXCEPTION 'Employee is not assigned to this hotel on that date' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_entry_assignment BEFORE INSERT ON time_entries
  FOR EACH ROW EXECUTE FUNCTION check_entry_assignment();

-- recorded only when hotel setting attendance.breakMode = 'recorded'
CREATE TABLE time_entry_breaks (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  time_entry_id  BIGINT NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  break_start_at TIMESTAMPTZ NOT NULL,
  break_end_at   TIMESTAMPTZ,
  CHECK (break_end_at IS NULL OR break_end_at > break_start_at)
);
CREATE UNIQUE INDEX uq_one_open_break ON time_entry_breaks(time_entry_id) WHERE break_end_at IS NULL;

-- every change to a time entry (employee request OR manager edit) is a correction row: full history, nothing overwritten
CREATE TABLE time_entry_corrections (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hotel_id                BIGINT NOT NULL,
  time_entry_id           BIGINT NOT NULL REFERENCES time_entries(id),
  employee_id             BIGINT NOT NULL,
  requested_by_id         BIGINT NOT NULL REFERENCES users(id),
  proposed_clock_in_at    TIMESTAMPTZ,
  proposed_clock_out_at   TIMESTAMPTZ,
  proposed_break_minutes  INT CHECK (proposed_break_minutes >= 0),
  reason                  TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by_id           BIGINT REFERENCES users(id),
  decided_at              TIMESTAMPTZ,
  decision_note           TEXT,
  original_clock_in_at    TIMESTAMPTZ,                 -- snapshot written when approved
  original_clock_out_at   TIMESTAMPTZ,
  original_break_minutes  INT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (employee_id, hotel_id) REFERENCES employee_hotels(employee_id, hotel_id),
  CONSTRAINT chk_correction_has_change CHECK (
    proposed_clock_in_at IS NOT NULL OR proposed_clock_out_at IS NOT NULL
    OR proposed_break_minutes IS NOT NULL)
);
CREATE INDEX idx_corrections_hotel ON time_entry_corrections(hotel_id, status);

-- ---------- audit (append-only, PII-free: ids and non-personal field changes only) ----------
CREATE TABLE audit_logs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT,
  hotel_id     BIGINT,
  user_id      BIGINT,
  action       TEXT NOT NULL,        -- e.g. schedule.create, time_off.approve, auth.login_failed
  entity_type  TEXT NOT NULL,
  entity_id    BIGINT,
  before       JSONB,
  after        JSONB,
  meta         JSONB,                -- requestId, deviceId, warnings, overrideReason (never names/emails/rates)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs(hotel_id, entity_type, entity_id);
CREATE INDEX idx_audit_time   ON audit_logs(hotel_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- ---------- updated_at triggers ----------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies','hotels','departments','shifts','shift_staffing_requirements',
    'employees','employee_work_targets','employee_vacation_allowance','users','time_offs',
    'schedules','employee_shift_wishes','employee_leave_wishes','time_entries','time_entry_corrections','inquiries']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- Down Migration
