-- Up Migration
-- Runtime support tables that are not part of spec Appendix A.

-- Single-use kiosk punch tokens (60 s). Stored hashed so several app instances can share them.
CREATE TABLE kiosk_punch_tokens (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  device_id    BIGINT NOT NULL REFERENCES kiosk_devices(id) ON DELETE CASCADE,
  employee_id  BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_punch_tokens_expiry ON kiosk_punch_tokens(expires_at);

CREATE INDEX idx_inquiries_employee_created ON inquiries(employee_id, created_at);
CREATE INDEX idx_time_offs_status ON time_offs(employee_id, status);

-- Down Migration
DROP INDEX IF EXISTS idx_time_offs_status;
DROP INDEX IF EXISTS idx_inquiries_employee_created;
DROP TABLE IF EXISTS kiosk_punch_tokens;
