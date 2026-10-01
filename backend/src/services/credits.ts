import { Db, rows } from '../db/pool';
import { addDays } from '../domain/dates';
import { homeHotelOf } from './access';
import { loadTargets } from './employees';

export interface DayCredit {
  date: string;
  type: string;
  fraction: number;
  /** minutes credited toward totals (annual leave, school, sick within limit) */
  creditMinutes: number;
  /** unpaid / other: reduces the monthly target */
  reducesTarget: boolean;
}

/**
 * R8 credit: approved annual leave, school and sick leave (first sickCreditMaxDays calendar days of a spell)
 * credit targetHoursPerWeek × 60 / |workWeekdays| × fraction. Unpaid/other credit nothing and reduce the target.
 */
export async function creditsFor(db: Db, employeeId: number, from: string, to: string): Promise<DayCredit[]> {
  const list = await rows(
    db,
    `SELECT d.date, d.day_fraction, t.type, t.start_date
       FROM time_off_dates d JOIN time_offs t ON t.id = d.time_off_id
      WHERE d.employee_id = $1 AND t.status = 'approved' AND d.date BETWEEN $2 AND $3
      ORDER BY d.date`,
    [employeeId, from, to],
  );
  if (list.length === 0) return [];
  const targets = await loadTargets(db, employeeId);
  const emp = (await rows(db, 'SELECT work_weekdays FROM employees WHERE id = $1', [employeeId]))[0];
  const perDay = (targets.targetHoursPerWeek * 60) / Math.max(1, emp.work_weekdays.length);
  const home = await homeHotelOf(db, employeeId);
  const sickLimit = home?.settings.absence.sickCreditMaxDays ?? 42;
  const out: DayCredit[] = [];
  const seen = new Map<string, DayCredit>();
  for (const r of list) {
    let credit = 0;
    let reduces = false;
    if (r.type === 'annual_leave' || r.type === 'school') credit = perDay * r.day_fraction;
    else if (r.type === 'sick_leave') credit = r.date <= addDays(r.start_date, sickLimit - 1) ? perDay * r.day_fraction : 0;
    else reduces = true;
    // a certified sick day inside vacation is one day: never credit the same date twice
    const prev = seen.get(r.date);
    if (prev) {
      prev.creditMinutes = Math.max(prev.creditMinutes, credit);
      if (r.type === 'sick_leave') prev.type = 'sick_leave';
      continue;
    }
    const c = { date: r.date, type: r.type, fraction: r.day_fraction, creditMinutes: credit, reducesTarget: reduces };
    seen.set(r.date, c);
    out.push(c);
  }
  return out;
}
