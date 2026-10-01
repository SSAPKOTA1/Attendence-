-- Up Migration
-- Owner decision (SPEC 1.14): vacation is entered at onboarding (yearly days, left from last year, left of this year)
-- and carries over automatically into the next year.
ALTER TABLE employee_vacation_allowance
  ADD COLUMN opening_used_days    NUMERIC(4,1) NOT NULL DEFAULT 0 CHECK (opening_used_days >= 0),
  ADD COLUMN carried_over_manual  BOOLEAN NOT NULL DEFAULT TRUE;

-- Down Migration
ALTER TABLE employee_vacation_allowance DROP COLUMN IF EXISTS carried_over_manual, DROP COLUMN IF EXISTS opening_used_days;
