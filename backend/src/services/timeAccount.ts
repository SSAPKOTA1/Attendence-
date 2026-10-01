import { Db, rows } from '../db/pool';
import type { AuthContext } from '../types/context';
import { eachDate, eachMonth, isoWeekday, monthOf, monthRange, todayIn } from '../domain/dates';
import { adjustedMonthlyTarget, balanceHours, monthDelta } from '../domain/timeAccount';
import { toHours } from '../domain/hours';
import { now } from '../clock';
import { getEmployeeAccess, homeHotelOf } from './access';
import { loadTargets } from './employees';
import { creditsFor } from './credits';
import { isHoliday } from './holidays';

export interface MonthAccount {
  month: string;
  workedMinutes: number;
  creditedMinutes: number;
  targetMinutes: number;
  deltaMinutes: number;
  openEntries: number;
}

/** Worked minutes of closed entries at all hotels by local clock-in month (or one hotel when hotelId is given). */
export async function workedByMonth(db: Db, employeeId: number, from: string, to: string, hotelId?: number) {
  const list = await rows(
    db,
    `SELECT to_char((te.clock_in_at AT TIME ZONE h.timezone)::date, 'YYYY-MM') AS month,
            COALESCE(SUM(GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (te.clock_out_at - te.clock_in_at)) / 60) - te.break_minutes)) FILTER (WHERE te.status = 'closed'), 0)::int AS worked,
            COUNT(*) FILTER (WHERE te.status <> 'closed')::int AS open
       FROM time_entries te JOIN hotels h ON h.id = te.hotel_id
      WHERE te.employee_id = $1 AND (te.clock_in_at AT TIME ZONE h.timezone)::date BETWEEN $2 AND $3
        AND ($4::bigint IS NULL OR te.hotel_id = $4)
      GROUP BY 1`,
    [employeeId, from, to, hotelId ?? null],
  );
  return new Map(list.map((r) => [r.month, { worked: r.worked, open: r.open }]));
}

export async function computeMonths(db: Db, employeeId: number, fromMonth: string, toMonth: string): Promise<MonthAccount[]> {
  const targets = await loadTargets(db, employeeId);
  const emp = (await rows(db, 'SELECT work_weekdays, public_holidays_off FROM employees WHERE id = $1', [employeeId]))[0];
  const home = await homeHotelOf(db, employeeId);
  const region = home?.holidayRegion ?? 'DE-HE';
  const from = monthRange(fromMonth).from;
  const to = monthRange(toMonth).to;
  const worked = await workedByMonth(db, employeeId, from, to);
  const credits = await creditsFor(db, employeeId, from, to);
  const out: MonthAccount[] = [];
  for (const month of eachMonth(fromMonth, toMonth)) {
    const r = monthRange(month);
    const workDays = eachDate(r.from, r.to).filter((d) => emp.work_weekdays.includes(isoWeekday(d)) && !(emp.public_holidays_off && isHoliday(region, d))).length;
    const mc = credits.filter((c) => monthOf(c.date) === month);
    const credited = mc.reduce((a, c) => a + c.creditMinutes, 0);
    const reduced = mc.filter((c) => c.reducesTarget).reduce((a, c) => a + c.fraction, 0);
    const target = adjustedMonthlyTarget(targets.targetHoursPerMonth, workDays, reduced);
    const w = worked.get(month) ?? { worked: 0, open: 0 };
    out.push({ month, workedMinutes: w.worked, creditedMinutes: credited, targetMinutes: target, deltaMinutes: monthDelta(w.worked, credited, target), openEntries: w.open });
  }
  return out;
}

/** E13: monthly time account; balance = opening balance + Σ monthly deltas since balanceStartDate. */
export async function timeAccount(db: Db, employeeId: number, fromMonth: string, toMonth: string) {
  const targets = await loadTargets(db, employeeId);
  const payType: 'salary' | 'hourly' = (await rows(db, 'SELECT pay_type FROM employees WHERE id = $1', [employeeId]))[0].pay_type;
  if (payType === 'hourly') {
    // SPEC 1.8: hourly workers are paid for the hours they work; no target, no balance (Arbeitszeitkonto)
    const months = await computeMonths(db, employeeId, fromMonth, toMonth);
    return {
      employeeId,
      payType,
      timeAccountEnabled: false,
      openingBalanceHours: null,
      balanceStartDate: null,
      months: months.map((m) => ({ month: m.month, workedHours: toHours(m.workedMinutes), creditedHours: toHours(m.creditedMinutes), targetHours: null, deltaHours: null, openEntries: m.openEntries })),
      balanceHours: null,
    };
  }
  const startMonth = targets.balanceStartDate ? monthOf(targets.balanceStartDate) : fromMonth;
  const first = startMonth < fromMonth ? startMonth : fromMonth;
  const months = await computeMonths(db, employeeId, first, toMonth);
  const counted = months.filter((m) => m.month >= startMonth && m.month <= toMonth);
  return {
    employeeId,
    payType,
    timeAccountEnabled: true,
    openingBalanceHours: targets.openingBalanceHours,
    balanceStartDate: targets.balanceStartDate,
    months: months
      .filter((m) => m.month >= fromMonth)
      .map((m) => ({
        month: m.month,
        workedHours: toHours(m.workedMinutes),
        creditedHours: toHours(m.creditedMinutes),
        targetHours: toHours(m.targetMinutes),
        deltaHours: toHours(m.deltaMinutes),
        openEntries: m.openEntries,
      })),
    balanceHours: balanceHours(targets.openingBalanceHours, counted.map((m) => m.deltaMinutes)),
  };
}

export async function getTimeAccount(db: Db, ctx: AuthContext, param: string | number, q: { from?: string; to?: string }) {
  const access = await getEmployeeAccess(db, ctx, param);
  const current = monthOf(todayIn('Europe/Berlin', now()));
  const to = q.to ?? current;
  const from = q.from ?? to;
  return timeAccount(db, access.employeeId, from, to);
}
