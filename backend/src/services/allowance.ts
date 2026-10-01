import { Db, maybeOne } from '../db/pool';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { ageOn, todayIn } from '../domain/dates';
import { remainingVacation, statutoryMinimumForMinor } from '../domain/vacation';
import { now } from '../clock';
import { audit } from './audit';
import { getEmployeeAccess, requireHomeManager } from './access';

async function ensureRow(db: Db, employeeId: number, year: number) {
  let r = await maybeOne(db, 'SELECT * FROM employee_vacation_allowance WHERE employee_id = $1 AND year = $2', [employeeId, year]);
  if (!r) {
    r = await maybeOne(
      db,
      `INSERT INTO employee_vacation_allowance (employee_id, year) VALUES ($1,$2)
       ON CONFLICT (employee_id, year) DO UPDATE SET year = EXCLUDED.year RETURNING *`,
      [employeeId, year],
    );
  }
  return r;
}

const CERTIFIED_SICK_SAME_DAY = `NOT EXISTS (SELECT 1 FROM time_off_dates sd JOIN time_offs st ON st.id = sd.time_off_id
   WHERE sd.employee_id = d.employee_id AND sd.date = d.date AND st.type = 'sick_leave' AND st.status = 'approved' AND st.medical_certificate_received)`;

export interface Allowance {
  employeeId: number;
  year: number;
  vacationDaysPerYear: number;
  carriedOverDays: number;
  carryOverExpiresOn: string | null;
  usedDays: number;
  pendingDays: number;
  remainingDays: number;
  updatedAt?: Date;
}

/** Allowance with usage derived from v_vacation_usage (never a stored counter). */
export async function computeAllowance(db: Db, employeeId: number, year: number): Promise<Allowance> {
  const r = await ensureRow(db, employeeId, year);
  const usage = await maybeOne(
    db,
    `SELECT COALESCE(SUM(days) FILTER (WHERE status = 'approved'), 0)::float AS used,
            COALESCE(SUM(days) FILTER (WHERE status = 'pending'), 0)::float AS pending
       FROM v_vacation_usage WHERE employee_id = $1 AND year = $2`,
    [employeeId, year],
  );
  let usedBeforeExpiry = 0;
  if (r.carry_over_expires_on) {
    usedBeforeExpiry = (
      await maybeOne(
        db,
        `SELECT COALESCE(SUM(d.day_fraction), 0)::float AS n FROM time_off_dates d JOIN time_offs t ON t.id = d.time_off_id
          WHERE d.employee_id = $1 AND t.type = 'annual_leave' AND t.status = 'approved'
            AND EXTRACT(YEAR FROM d.date) = $2 AND d.date <= $3 AND ${CERTIFIED_SICK_SAME_DAY}`,
        [employeeId, year, r.carry_over_expires_on],
      )
    ).n;
  }
  const remainingDays = remainingVacation({
    vacationDaysPerYear: r.vacation_days_per_year,
    carriedOverDays: r.carried_over_days,
    carryOverExpiresOn: r.carry_over_expires_on,
    usedDays: usage.used,
    usedOnOrBeforeExpiry: usedBeforeExpiry,
    today: todayIn('Europe/Berlin', now()),
  });
  return {
    employeeId,
    year,
    vacationDaysPerYear: r.vacation_days_per_year,
    carriedOverDays: r.carried_over_days,
    carryOverExpiresOn: r.carry_over_expires_on,
    usedDays: usage.used,
    pendingDays: usage.pending,
    remainingDays,
    updatedAt: r.updated_at,
  };
}

export async function getAllowance(db: Db, ctx: AuthContext, id: string | number, year?: number) {
  const access = await getEmployeeAccess(db, ctx, id);
  if (!access.fullView) throw new AppError('FORBIDDEN');
  const y = year ?? Number(todayIn('Europe/Berlin', now()).slice(0, 4));
  return computeAllowance(db, access.employeeId, y);
}

export async function putAllowance(
  db: Db,
  ctx: AuthContext,
  id: string | number,
  input: { year: number; vacationDaysPerYear: number; carriedOverDays?: number; carryOverExpiresOn?: string | null },
) {
  const access = await getEmployeeAccess(db, ctx, id);
  requireHomeManager(access);
  const before = await ensureRow(db, access.employeeId, input.year);
  await db.query(
    `UPDATE employee_vacation_allowance SET vacation_days_per_year = $3, carried_over_days = $4, carry_over_expires_on = $5
      WHERE employee_id = $1 AND year = $2`,
    [access.employeeId, input.year, input.vacationDaysPerYear, input.carriedOverDays ?? before.carried_over_days,
      input.carryOverExpiresOn === undefined ? before.carry_over_expires_on : input.carryOverExpiresOn],
  );
  await audit(db, ctx, {
    action: 'allowance.update', entityType: 'employee', entityId: access.employeeId, hotelId: access.homeHotelId,
    before: { year: input.year, vacationDaysPerYear: before.vacation_days_per_year, carriedOverDays: before.carried_over_days },
    after: input,
  });
  const result: any = await computeAllowance(db, access.employeeId, input.year);
  const warnings = [];
  const e = access.employee;
  if (e.birth_date) {
    const age = ageOn(e.birth_date, `${input.year}-01-01`);
    const min = statutoryMinimumForMinor(age, e.work_weekdays.length);
    if (min !== null && input.vacationDaysPerYear < min) {
      warnings.push({
        type: 'below_statutory_minimum',
        severity: 'warning',
        message: `Below the statutory minimum for minors (JArbSchG): at least ${min} days for this work week`,
        minimumDays: min,
        ageAtYearStart: age,
      });
    }
  }
  result.warnings = warnings;
  return result;
}
