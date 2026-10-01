-- Up Migration
-- Owner decision (SPEC 1.12): clocking in without a planned shift needs a reason, and those hours only count once a
-- supervisor approved them.
ALTER TABLE time_entries
  ADD COLUMN unplanned_reason TEXT,
  ADD COLUMN approval_status  TEXT NOT NULL DEFAULT 'not_required'
      CHECK (approval_status IN ('not_required','pending','approved','rejected')),
  ADD COLUMN approved_by_id   BIGINT REFERENCES users(id),
  ADD COLUMN approved_at      TIMESTAMPTZ,
  ADD COLUMN approval_note    TEXT,
  ADD CONSTRAINT chk_unplanned_reason CHECK (approval_status = 'not_required' OR (unplanned_reason IS NOT NULL AND length(trim(unplanned_reason)) > 0)),
  ADD CONSTRAINT chk_approval_decided CHECK ((approval_status IN ('approved','rejected')) = (approved_at IS NOT NULL));
CREATE INDEX idx_time_entries_approval ON time_entries(hotel_id, approval_status) WHERE approval_status = 'pending';

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'roster_published','roster_entry_changed','roster_entry_removed','absence_decided','wish_decided','correction_decided',
  'inquiry_reply','inquiry_new','absence_requested','wish_submitted','correction_requested','needs_review_entry','sick_reported',
  'time_approval_requested','time_approval_decided'));

-- Down Migration
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'roster_published','roster_entry_changed','roster_entry_removed','absence_decided','wish_decided','correction_decided',
  'inquiry_reply','inquiry_new','absence_requested','wish_submitted','correction_requested','needs_review_entry','sick_reported'));
DROP INDEX IF EXISTS idx_time_entries_approval;
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS chk_approval_decided, DROP CONSTRAINT IF EXISTS chk_unplanned_reason,
  DROP COLUMN IF EXISTS approval_note, DROP COLUMN IF EXISTS approved_at, DROP COLUMN IF EXISTS approved_by_id,
  DROP COLUMN IF EXISTS approval_status, DROP COLUMN IF EXISTS unplanned_reason;
