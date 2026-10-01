-- Up Migration
-- Owner decision (SPEC 1.8): per employee, salaried vs hourly wage, and whether public holidays are paid days off.
ALTER TABLE employees
  ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'salary' CHECK (pay_type IN ('salary','hourly')),
  ADD COLUMN public_holidays_off BOOLEAN NOT NULL DEFAULT true;

-- Down Migration
ALTER TABLE employees DROP COLUMN IF EXISTS public_holidays_off, DROP COLUMN IF EXISTS pay_type;
