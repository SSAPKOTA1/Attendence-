import { Db, maybeOne } from '../db/pool';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { ageOn, todayIn } from '../domain/dates';
import { remainingVacation, statutoryMinimumForMinor } from '../domain/vacation';
import { now } from '../clock';
import { audit } from './audit';
import { getEmployeeAccess, loadHotel, requireHomeManager } from './access';

const findRow = (db: Db, employeeId: number, year: number) =>
  maybeOne(db, 'SELECT * FROM employee_vacation_allowance WHERE employee_id = $1 AND year = $2', [employeeId, year]);

async function homeAbsenceSettings(db: Db, employeeId: number) {
  const h = await maybeOne(db, 'SELECT hotel_id FROM employee_hotels WHERE employee_id = $1 AND is_home', [employeeId]);
  return (await loadHotel(db, h.hotel_id)).settings.absence;
}

/** A missing row is created from the previous year: same yearly days, carry-over calculated automatically (SPEC 1.14). */
async function ensureRow(db: Db, employeeId: number, year: number) {
  const existing = await findRow(db, employeeId, year);
  if (existing) return existing;
  const prev = await findRow(db, employeeId, year - 1);
  let expires: string | null = null;
  if (prev) {
    const md = (await homeAbsenceSettings(db, employeeId)).carryOverExpiresOn;
    expires = md ? `${year}-${md}` : null;
  }
  return maybeOne(
    db,
    `INSERT INTO employee_vacation_allowance (employee_id, year, vacation_days_per_year, carried_over_manual, carry_over_expires_on)
     VALUES ($1,$2,COALESCE($3, 30.0),FALSE,$4)
     ON CONFLICT (employee_id, year) DO UPDATE SET year = EXCLUDED.year RETURNING *`,
    [employeeId, year, prev ? prev.vacation_days_per_year : null, expires],
  );
}

const CERTIFIED_SICK_SAME_DAY = `NOT EXISTS (SELECT 1 FROM time_off_dates sd JOIN time_offs st ON st.id = sd.time_off_id
   WHERE sd.employee_id = d.employee_id AND sd.date = d.date AND st.type = 'sick_leave' AND st.status = 'approved' AND st.medical_certificate_received)`;

export interface Allowance {
  employeeId: number;
  year: number;
  vacationDaysPerYear: number;
  carriedOverDays: number;
  carryOverExpiresOn: string | null;
  /** true: carry-over is calculated from the previous year; false: entered by hand */
  carryOverAutomatic: boolean;
  /** days already taken in this year before the employee was entered into the system */
  alreadyTakenDays: number;
  usedDays: number;
  pendingDays: number;
  remainingDays: number;
  updatedAt?: Date;
}

/** Allowance of one existing row; usage derived from v_vacation_usage (never a stored counter). */
async function computeFromRow(db: Db, r: any): Promise<Allowance> {
  const { employee_id: employeeId, year } = r;
  const usage = await maybeOne(
    db,
    `SELECT COALESCE(SUM(days) FILTER (WHERE status = 'approved'), 0)::float AS used,
            COALESCE(SUM(days) FILTER (WHERE status = 'pending'), 0)::float AS pending
       FROM v_vacation_usage WHERE employee_id = $1 AND year = $2`,
    [employeeId, year],
  );
  const opening = Number(r.opening_used_days);
  let usedBeforeExpiry = opening;
  if (r.carry_over_expires_on) {
    usedBeforeExpiry += (
      await maybeOne(
        db,
        `SELECT COALESCE(SUM(d.day_fraction), 0)::float AS n FROM time_off_dates d JOIN time_offs t ON t.id = d.time_off_id
          WHERE d.employee_id = $1 AND t.type = 'annual_leave' AND t.status = 'approved'
            AND EXTRACT(YEAR FROM d.date) = $2 AND d.date <= $3 AND ${CERTIFIED_SICK_SAME_DAY}`,
        [employeeId, year, r.carry_over_expires_on],
      )
    ).n;
  }
  const carried = r.carried_over_manual ? Number(r.carried_over_days) : await autoCarry(db, employeeId, year);
  const usedDays = usage.used + opening;
  const remainingDays = remainingVacation({
    vacationDaysPerYear: Number(r.vacation_days_per_year),
    carriedOverDays: carried,
    carryOverExpiresOn: r.carry_over_expires_on,
    usedDays,
    usedOnOrBeforeExpiry: usedBeforeExpiry,
    today: todayIn('Europe/Berlin', now()),
  });
  return {
    employeeId,
    year,
    vacationDaysPerYear: Number(r.vacation_days_per_year),
    carriedOverDays: carried,
    carryOverExpiresOn: r.carry_over_expires_on,
    carryOverAutomatic: !r.carried_over_manual,
    alreadyTakenDays: opening,
    usedDays,
    pendingDays: usage.pending,
    remainingDays,
    updatedAt: r.updated_at,
  };
}

/** SPEC 1.14: what is left of the previous year's allowance (never negative, optionally capped) carries over. */
async function autoCarry(db: Db, employeeId: number, year: number): Promise<number> {
  const prev = await findRow(db, employeeId, year - 1);
  if (!prev) return 0;
  const left = Math.max(0, (await computeFromRow(db, prev)).remainingDays);
  const cap = (await homeAbsenceSettings(db, employeeId)).maxCarryOverDays;
  return Math.round((cap === null ? left : Math.min(left, cap)) * 10) / 10;
}

export async function computeAllowance(db: Db, employeeId: number, year: number): Promise<Allowance> {
  return computeFromRow(db, await ensureRow(db, employeeId, year));
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
  input: { year: number; vacationDaysPerYear: number; carriedOverDays?: number | null; carryOverExpiresOn?: string | null; alreadyTakenDays?: number },
) {
  const access = await getEmployeeAccess(db, ctx, id);
  requireHomeManager(access);
  const before = await ensureRow(db, access.employeeId, input.year);
  // carriedOverDays: a number fixes it by hand, null returns to the automatic carry-over, omitted keeps the current mode
  const manual = input.carriedOverDays === undefined ? before.carried_over_manual : input.carriedOverDays !== null;
  const carried = typeof input.carriedOverDays === 'number' ? input.carriedOverDays : before.carried_over_days;
  await db.query(
    `UPDATE employee_vacation_allowance SET vacation_days_per_year = $3, carried_over_days = $4, carry_over_expires_on = $5,
            carried_over_manual = $6, opening_used_days = $7
      WHERE employee_id = $1 AND year = $2`,
    [access.employeeId, input.year, input.vacationDaysPerYear, carried,
      input.carryOverExpiresOn === undefined ? before.carry_over_expires_on : input.carryOverExpiresOn, manual,
      input.alreadyTakenDays ?? before.opening_used_days],
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

/** Onboarding (SPEC 1.14): yearly days, days left from last year, days left of this year's own entitlement. */
export async function setOpeningBalance(
  db: Db,
  employeeId: number,
  v: { year: number; vacationDaysPerYear: number; carriedOverDays: number; remainingThisYearDays: number; carryOverExpiresOn?: string | null },
) {
  const taken = Math.round((v.vacationDaysPerYear - v.remainingThisYearDays) * 10) / 10;
  await db.query(
    `INSERT INTO employee_vacation_allowance (employee_id, year, vacation_days_per_year, carried_over_days, carry_over_expires_on, opening_used_days, carried_over_manual)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE)
     ON CONFLICT (employee_id, year) DO UPDATE SET vacation_days_per_year = EXCLUDED.vacation_days_per_year,
       carried_over_days = EXCLUDED.carried_over_days, carry_over_expires_on = EXCLUDED.carry_over_expires_on,
       opening_used_days = EXCLUDED.opening_used_days, carried_over_manual = TRUE`,
    [employeeId, v.year, v.vacationDaysPerYear, v.carriedOverDays, v.carryOverExpiresOn ?? null, taken],
  );
}
