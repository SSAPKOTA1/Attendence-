-- Up Migration
-- Owner decision (SPEC 1.13): a forgotten clock-out on a planned shift is closed automatically with the planned hours.
ALTER TABLE time_entries DROP CONSTRAINT time_entries_source_out_check;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_source_out_check CHECK (source_out IN ('kiosk','manager','system'));

-- Down Migration
UPDATE time_entries SET source_out = 'manager' WHERE source_out = 'system';
ALTER TABLE time_entries DROP CONSTRAINT time_entries_source_out_check;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_source_out_check CHECK (source_out IN ('kiosk','manager'));
