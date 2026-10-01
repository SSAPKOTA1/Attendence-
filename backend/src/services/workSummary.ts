import { Db } from '../db/pool';
import type { AuthContext } from '../types/context';
import { addDays, maxDate, minDate, todayIn, weekEnd, weekStart } from '../domain/dates';
import { toHours } from '../domain/hours';
import { now } from '../clock';
import { getEmployeeAccess } from './access';
import { loadTargets } from './employees';
import { creditsFor } from './credits';
import { loadEmployeeEntries } from './roster/entries';

/**
 * E8: planned (scheduled) paid hours + credited hours vs targets, per Monday–Sunday week, across all hotels.
 * Managers see draft + published; the employee sees published only.
 */
export async function workSummary(db: Db, ctx: AuthContext, param: string | number, q: { from?: string; to?: string }) {
  const access = await getEmployeeAccess(db, ctx, param);
  const today = todayIn('Europe/Berlin', now());
  const from = q.from ?? weekStart(today);
  const to = q.to ?? weekEnd(today);
  const publishedOnly = ctx.role === 'staff' || (access.isSelf && !access.isHomeManager && ctx.role !== 'admin');
  return computeWorkSummary(db, access.employeeId, access.employee.work_weekdays.length, from, to, publishedOnly);
}

export async function computeWorkSummary(db: Db, employeeId: number, workDayCount: number, from: string, to: string, publishedOnly: boolean) {
  const targets = await loadTargets(db, employeeId);
  const entries = await loadEmployeeEntries(db, employeeId, from, to, { publishedOnly });
  const credits = await creditsFor(db, employeeId, from, to);
  const perDay = (targets.targetHoursPerWeek * 60) / Math.max(1, workDayCount);
  const weeks = [];
  const warnings = [];
  let ws = weekStart(from);
  let totalSched = 0;
  let totalCredit = 0;
  let totalTarget = 0;
  while (ws <= to) {
    const we = weekEnd(ws);
    const a = maxDate(ws, from);
    const b = minDate(we, to);
    const sched = entries.filter((e) => e.date >= a && e.date <= b && e.entryType === 'shift').reduce((s, e) => s + e.paidMinutes, 0);
    const wc = credits.filter((c) => c.date >= a && c.date <= b);
    const credit = wc.reduce((s, c) => s + c.creditMinutes, 0);
    const reduce = wc.filter((c) => c.reducesTarget).reduce((s, c) => s + perDay * c.fraction, 0);
    const target = Math.max(0, targets.targetHoursPerWeek * 60 - reduce);
    const total = sched + credit;
    let status: 'below' | 'on_target' | 'above' | 'over_max';
    if (total > targets.maxHoursPerWeek * 60) status = 'over_max';
    else if (total > target + 0.5) status = 'above';
    else if (total < target - 0.5) status = 'below';
    else status = 'on_target';
    weeks.push({ weekStart: ws, scheduledPaidHours: toHours(sched), creditedHours: toHours(credit), targetHours: toHours(target), status });
    if (status === 'below') {
      warnings.push({ type: 'below_target_week', severity: 'info', weekStart: ws, actualHours: toHours(total), targetHours: toHours(target) });
    } else if (status === 'over_max') {
      warnings.push({ type: 'exceeds_max_week', severity: 'warning', weekStart: ws, actualHours: toHours(total), maxHours: targets.maxHoursPerWeek });
    }
    totalSched += sched;
    totalCredit += credit;
    totalTarget += target;
    ws = addDays(ws, 7);
  }
  return {
    employeeId,
    from,
    to,
    scheduledPaidHours: toHours(totalSched),
    creditedHours: toHours(totalCredit),
    targetHours: toHours(totalTarget),
    delta: toHours(totalSched + totalCredit - totalTarget),
    weeks,
    warnings,
  };
}
