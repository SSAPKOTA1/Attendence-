import { Db, maybeOne, rows } from '../db/pool';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { addDays, eachDate, eachMonth, isoWeekday, monthOf, monthRange, daysBetween } from '../domain/dates';
import { bradfordFactor, mergeSpells } from '../domain/bradford';
import { shiftInstants } from '../domain/instants';
import { toHours } from '../domain/hours';
import { workedMinutes } from '../domain/anomalies';
import { countsAsWorked } from '../domain/approval';
import { now } from '../clock';
import { loadHotel } from './access';
import { creditsFor } from './credits';
import { loadTargets } from './employees';

function assertHotel(ctx: AuthContext, hotelId: number) {
  if (!ctx.hotelIds.includes(hotelId)) throw new AppError('RESOURCE_NOT_FOUND');
}

function checkRange(from: string, to: string) {
  if (to < from) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'to', issue: 'must not be before from' }] });
  if (daysBetween(from, to) > 400) throw new AppError('RANGE_TOO_LARGE');
}

/** Employees whose HOME hotel is this hotel (absences and headcount are attributed there, 8.2). */
async function homeEmployees(db: Db, hotelId: number, departmentId?: number) {
  return rows(
    db,
    `SELECT e.id, e.first_name, e.last_name, e.status FROM employees e JOIN employee_hotels eh ON eh.employee_id = e.id AND eh.is_home AND eh.hotel_id = $1
      WHERE e.deleted_at IS NULL AND ($2::bigint IS NULL OR EXISTS (SELECT 1 FROM employee_departments ed WHERE ed.employee_id = e.id AND ed.department_id = $2))
      ORDER BY e.last_name, e.first_name`,
    [hotelId, departmentId ?? null],
  );
}

interface SickStats {
  sickDays: number;
  spells: number;
  scheduledShiftDays: number;
  missingCertificates: number;
}

async function sickStats(db: Db, employeeId: number, from: string, to: string, noteFromDay: number): Promise<SickStats> {
  const entries = await rows(
    db,
    `SELECT id, start_date, end_date, medical_certificate_received FROM time_offs
      WHERE employee_id = $1 AND type = 'sick_leave' AND status = 'approved' AND start_date <= $3 AND end_date >= $2 ORDER BY start_date`,
    [employeeId, from, to],
  );
  const days = (
    await maybeOne(
      db,
      `SELECT COALESCE(SUM(d.day_fraction),0)::float n FROM time_off_dates d JOIN time_offs t ON t.id = d.time_off_id
        WHERE d.employee_id = $1 AND t.type = 'sick_leave' AND t.status = 'approved' AND d.date BETWEEN $2 AND $3`,
      [employeeId, from, to],
    )
  ).n;
  const spells = mergeSpells(entries.map((e) => ({ ...e, startDate: e.start_date, endDate: e.end_date })), addDays);
  const missing = spells.filter((sp) => {
    const start = sp[0].startDate;
    const end = sp.reduce((m, x) => (x.endDate > m ? x.endDate : m), sp[0].endDate);
    return daysBetween(start, end) + 1 > noteFromDay - 1 && sp.some((x) => !x.medical_certificate_received);
  }).length;
  const shiftDays = (
    await maybeOne(db, `SELECT count(DISTINCT date)::int n FROM schedules WHERE employee_id = $1 AND entry_type = 'shift' AND date BETWEEN $2 AND $3`, [employeeId, from, to])
  ).n;
  return { sickDays: days, spells: spells.length, scheduledShiftDays: shiftDays, missingCertificates: missing };
}

const rate = (sick: number, shifts: number) => (sick + shifts > 0 ? Math.round((sick / (sick + shifts)) * 10000) / 10000 : 0);

export async function absences(db: Db, ctx: AuthContext, hotelId: number, q: { from: string; to: string; departmentId?: number }) {
  assertHotel(ctx, hotelId);
  checkRange(q.from, q.to);
  const hotel = await loadHotel(db, hotelId);
  const emps = await homeEmployees(db, hotelId, q.departmentId);
  const byEmployee = [];
  const deptAgg = new Map<number, { departmentId: number; name: string; sickDays: number; spells: number; shiftDays: number; employees: Set<number> }>();
  let tSick = 0, tSpells = 0, tShift = 0, affected = 0;
  for (const e of emps) {
    const s = await sickStats(db, e.id, q.from, q.to, hotel.settings.absence.sickNoteRequiredFromDay);
    const depts = await rows(db, 'SELECT d.id, d.name FROM employee_departments ed JOIN departments d ON d.id = ed.department_id WHERE ed.employee_id = $1 AND d.hotel_id = $2', [e.id, hotelId]);
    tSick += s.sickDays;
    tSpells += s.spells;
    tShift += s.scheduledShiftDays;
    if (s.spells > 0) affected++;
    byEmployee.push({
      employeeId: e.id,
      name: `${e.first_name} ${e.last_name}`,
      department: depts.map((d) => d.name).join(', ') || null,
      sickDays: s.sickDays,
      spells: s.spells,
      bradfordFactor: bradfordFactor(s.spells, s.sickDays),
      missingCertificates: s.missingCertificates,
    });
    for (const d of depts) {
      const agg = deptAgg.get(d.id) ?? { departmentId: d.id, name: d.name, sickDays: 0, spells: 0, shiftDays: 0, employees: new Set<number>() };
      agg.sickDays += s.sickDays;
      agg.spells += s.spells;
      agg.shiftDays += s.scheduledShiftDays;
      if (s.spells > 0) agg.employees.add(e.id);
      deptAgg.set(d.id, agg);
    }
  }
  return {
    from: q.from,
    to: q.to,
    totals: { sickDays: tSick, spells: tSpells, employeesAffected: affected, absenceRate: rate(tSick, tShift) },
    byEmployee,
    byDepartment: [...deptAgg.values()].map((d) => ({ departmentId: d.departmentId, name: d.name, sickDays: d.sickDays, spells: d.spells, employeesAffected: d.employees.size, absenceRate: rate(d.sickDays, d.shiftDays) })),
  };
}

export async function absenceTrend(db: Db, ctx: AuthContext, hotelId: number, q: { from: string; to: string }) {
  assertHotel(ctx, hotelId);
  checkRange(q.from, q.to);
  const hotel = await loadHotel(db, hotelId);
  const emps = await homeEmployees(db, hotelId);
  const series = [];
  for (const m of eachMonth(monthOf(q.from), monthOf(q.to))) {
    const r = monthRange(m);
    const from = r.from < q.from ? q.from : r.from;
    const to = r.to > q.to ? q.to : r.to;
    let sick = 0, spells = 0, shifts = 0;
    for (const e of emps) {
      const s = await sickStats(db, e.id, from, to, hotel.settings.absence.sickNoteRequiredFromDay);
      sick += s.sickDays;
      spells += s.spells;
      shifts += s.scheduledShiftDays;
    }
    series.push({ period: m, sickDays: sick, spells, absenceRate: rate(sick, shifts) });
  }
  return { series };
}

export async function hours(db: Db, ctx: AuthContext, hotelId: number, month: string) {
  assertHotel(ctx, hotelId);
  const { from, to } = monthRange(month);
  const emps = await rows(
    db,
    `SELECT e.id, e.first_name, e.last_name, eh.is_home FROM employees e JOIN employee_hotels eh ON eh.employee_id = e.id AND eh.hotel_id = $1
      WHERE e.deleted_at IS NULL AND (eh.unassigned_on IS NULL OR eh.unassigned_on >= $2::date) ORDER BY e.last_name, e.first_name`,
    [hotelId, from],
  );
  const byEmployee = [];
  for (const e of emps) {
    const sched = (
      await maybeOne(
        db,
        `SELECT COALESCE(SUM(sh.duration_minutes - sh.break_duration_minutes),0)::int n FROM schedules s JOIN shifts sh ON sh.id = s.shift_id
          WHERE s.employee_id = $1 AND s.hotel_id = $2 AND s.date BETWEEN $3 AND $4`,
        [e.id, hotelId, from, to],
      )
    ).n;
    const credited = e.is_home ? (await creditsFor(db, e.id, from, to)).reduce((a, c) => a + c.creditMinutes, 0) : 0;
    const targets = await loadTargets(db, e.id);
    const target = e.is_home ? targets.targetHoursPerMonth * 60 : 0;
    const total = sched + credited;
    const status = total > targets.maxHoursPerMonth * 60 ? 'over_max' : total > target + 0.5 ? 'above' : total < target - 0.5 ? 'below' : 'on_target';
    byEmployee.push({ employeeId: e.id, name: `${e.first_name} ${e.last_name}`, isHome: e.is_home, scheduledPaidHours: toHours(sched), creditedHours: toHours(credited), targetHours: toHours(target), delta: toHours(total - target), status });
  }
  return { month, byEmployee };
}

async function noShowCount(db: Db, hotelId: number, tz: string, employeeId: number, from: string, to: string, tolMin: number) {
  const t = now();
  const shifts = await rows(
    db,
    `SELECT s.id, s.date, sh.start_time, sh.end_time FROM schedules s JOIN shifts sh ON sh.id = s.shift_id JOIN employees e ON e.id = s.employee_id
      WHERE s.hotel_id = $1 AND s.employee_id = $2 AND s.status = 'published' AND s.entry_type = 'shift' AND s.date BETWEEN $3 AND $4 AND e.attendance_required`,
    [hotelId, employeeId, from, to],
  );
  let n = 0;
  for (const s of shifts) {
    const inst = shiftInstants(s.date, s.start_time, s.end_time, tz);
    if (inst.end.getTime() + tolMin * 60_000 > t.getTime()) continue;
    const entry = await maybeOne(
      db,
      `SELECT 1 FROM time_entries WHERE employee_id = $1 AND (schedule_id = $2 OR tstzrange(clock_in_at, COALESCE(clock_out_at, 'infinity')) && tstzrange($3::timestamptz, $4::timestamptz)) LIMIT 1`,
      [employeeId, s.id, new Date(inst.start.getTime() - 2 * 3_600_000), inst.end],
    );
    if (entry) continue;
    const absent = await maybeOne(db, `SELECT 1 FROM time_offs WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2 AND end_date >= $2`, [employeeId, s.date]);
    if (!absent) n++;
  }
  return n;
}

export async function attendanceAnalytics(db: Db, ctx: AuthContext, hotelId: number, q: { from: string; to: string }) {
  assertHotel(ctx, hotelId);
  checkRange(q.from, q.to);
  const hotel = await loadHotel(db, hotelId);
  const emps = await rows(
    db,
    `SELECT DISTINCT e.id, e.first_name, e.last_name FROM employees e WHERE e.id IN (
        SELECT employee_id FROM schedules WHERE hotel_id = $1 AND date BETWEEN $2 AND $3
        UNION SELECT employee_id FROM time_entries WHERE hotel_id = $1 AND (clock_in_at AT TIME ZONE $4)::date BETWEEN $2 AND $3)
      ORDER BY e.last_name, e.first_name`,
    [hotelId, q.from, q.to, hotel.timezone],
  );
  const byEmployee = [];
  const totals = { plannedPaidHours: 0, actualPaidHours: 0, lateCount: 0, earlyLeaveCount: 0, noShowCount: 0, unscheduledCount: 0, overtimeHours: 0, openOrReviewEntries: 0, entriesAwaitingApproval: 0 };
  for (const e of emps) {
    const planned = (
      await maybeOne(
        db,
        `SELECT COALESCE(SUM(sh.duration_minutes - sh.break_duration_minutes),0)::int n FROM schedules s JOIN shifts sh ON sh.id = s.shift_id
          WHERE s.employee_id = $1 AND s.hotel_id = $2 AND s.status = 'published' AND s.date BETWEEN $3 AND $4`,
        [e.id, hotelId, q.from, q.to],
      )
    ).n;
    const entries = await rows(
      db,
      `SELECT * FROM time_entries WHERE employee_id = $1 AND hotel_id = $2 AND (clock_in_at AT TIME ZONE $5)::date BETWEEN $3 AND $4`,
      [e.id, hotelId, q.from, q.to, hotel.timezone],
    );
    let actual = 0, late = 0, early = 0, unscheduled = 0, overtime = 0, open = 0, awaiting = 0;
    for (const te of entries) {
      if (te.approval_status === 'pending') awaiting++;
      if (te.status !== 'closed') open++;
      // unapproved / refused unplanned work has no hours, but its anomalies (late, unscheduled, ...) still count below
      if (countsAsWorked(te)) actual += workedMinutes(new Date(te.clock_in_at), new Date(te.clock_out_at), te.break_minutes) ?? 0;
      for (const a of te.anomalies ?? []) {
        if (a.type === 'late_clock_in') late++;
        if (a.type === 'early_clock_out') early++;
        if (a.type === 'unscheduled_work') unscheduled++;
        if (a.type === 'overtime') overtime += a.minutes ?? 0;
      }
    }
    const noShows = await noShowCount(db, hotelId, hotel.timezone, e.id, q.from, q.to, hotel.settings.attendance.lateToleranceMinutes);
    const row = {
      employeeId: e.id,
      name: `${e.first_name} ${e.last_name}`,
      plannedPaidHours: toHours(planned),
      actualPaidHours: toHours(actual),
      lateCount: late,
      earlyLeaveCount: early,
      noShowCount: noShows,
      unscheduledCount: unscheduled,
      overtimeHours: toHours(overtime),
      openOrReviewEntries: open,
      entriesAwaitingApproval: awaiting,
    };
    byEmployee.push(row);
    totals.plannedPaidHours += row.plannedPaidHours;
    totals.actualPaidHours += row.actualPaidHours;
    totals.lateCount += late;
    totals.earlyLeaveCount += early;
    totals.noShowCount += noShows;
    totals.unscheduledCount += unscheduled;
    totals.overtimeHours += row.overtimeHours;
    totals.openOrReviewEntries += open;
    totals.entriesAwaitingApproval += awaiting;
  }
  totals.plannedPaidHours = toHours(totals.plannedPaidHours * 60);
  totals.actualPaidHours = toHours(totals.actualPaidHours * 60);
  totals.overtimeHours = toHours(totals.overtimeHours * 60);
  return { from: q.from, to: q.to, byEmployee, totals };
}

/** N6: only hotels in the caller's access set. */
export async function overview(db: Db, ctx: AuthContext, q: { hotelIds?: number[]; from: string; to: string }) {
  checkRange(q.from, q.to);
  const ids = (q.hotelIds && q.hotelIds.length ? q.hotelIds : ctx.hotelIds).filter((h) => ctx.hotelIds.includes(h));
  const hotels = [];
  for (const hotelId of ids) {
    const hotel = await loadHotel(db, hotelId);
    const headcount = (
      await maybeOne(
        db,
        `SELECT count(*)::int n FROM employees e JOIN employee_hotels eh ON eh.employee_id = e.id AND eh.is_home AND eh.hotel_id = $1
          WHERE e.deleted_at IS NULL AND e.status <> 'terminated'`,
        [hotelId],
      )
    ).n;
    const sched = (
      await maybeOne(
        db,
        `SELECT COALESCE(SUM(sh.duration_minutes - sh.break_duration_minutes),0)::int n FROM schedules s JOIN shifts sh ON sh.id = s.shift_id
          WHERE s.hotel_id = $1 AND s.date BETWEEN $2 AND $3`,
        [hotelId, q.from, q.to],
      )
    ).n;
    const entries = await rows(db, `SELECT * FROM time_entries WHERE hotel_id = $1 AND status = 'closed' AND approval_status IN ('not_required','approved') AND (clock_in_at AT TIME ZONE $4)::date BETWEEN $2 AND $3`, [hotelId, q.from, q.to, hotel.timezone]);
    const actual = entries.reduce((a, te) => a + (workedMinutes(new Date(te.clock_in_at), new Date(te.clock_out_at), te.break_minutes) ?? 0), 0);
    const emps = await homeEmployees(db, hotelId);
    let sick = 0, shifts = 0;
    for (const e of emps) {
      const s = await sickStats(db, e.id, q.from, q.to, hotel.settings.absence.sickNoteRequiredFromDay);
      sick += s.sickDays;
      shifts += s.scheduledShiftDays;
    }
    const reqs = await rows(db, 'SELECT shift_id, weekday, min_staff FROM shift_staffing_requirements WHERE hotel_id = $1 AND min_staff > 0', [hotelId]);
    let understaffed = 0;
    if (reqs.length) {
      const counts = await rows(db, `SELECT shift_id, date, count(*)::int n FROM schedules WHERE hotel_id = $1 AND entry_type = 'shift' AND date BETWEEN $2 AND $3 GROUP BY shift_id, date`, [hotelId, q.from, q.to]);
      for (const date of eachDate(q.from, q.to)) {
        for (const r of reqs.filter((x) => x.weekday === isoWeekday(date))) {
          const c = counts.find((x) => x.shift_id === r.shift_id && x.date === date)?.n ?? 0;
          if (c < r.min_staff) understaffed++;
        }
      }
    }
    const openCorrections = (await maybeOne(db, `SELECT count(*)::int n FROM time_entry_corrections WHERE hotel_id = $1 AND status = 'pending'`, [hotelId])).n;
    const needsReview = (await maybeOne(db, `SELECT count(*)::int n FROM time_entries WHERE hotel_id = $1 AND status = 'needs_review'`, [hotelId])).n;
    const unpublished = (await maybeOne(db, `SELECT count(DISTINCT date)::int n FROM schedules WHERE hotel_id = $1 AND status = 'draft' AND date BETWEEN $2 AND $3`, [hotelId, q.from, q.to])).n;
    hotels.push({
      hotelId,
      name: hotel.name,
      headcount,
      scheduledPaidHours: toHours(sched),
      actualPaidHours: toHours(actual),
      sickRate: rate(sick, shifts),
      understaffedShifts: understaffed,
      openCorrections,
      needsReviewEntries: needsReview,
      unpublishedDays: unpublished,
    });
  }
  return { from: q.from, to: q.to, hotels };
}

export async function auditLogs(
  db: Db,
  ctx: AuthContext,
  q: { hotelId?: number; entityType?: string; entityId?: number; userId?: number; action?: string; from?: string; to?: string; page: number; limit: number },
) {
  if (q.hotelId && !ctx.hotelIds.includes(q.hotelId)) throw new AppError('RESOURCE_NOT_FOUND');
  const params: unknown[] = [
    ctx.companyId, q.hotelId ?? null, q.entityType ?? null, q.entityId ?? null, q.userId ?? null, q.action ?? null,
    q.from ? new Date(`${q.from}T00:00:00Z`) : null, q.to ? new Date(`${q.to}T23:59:59.999Z`) : null,
  ];
  let scope = 'company_id = $1';
  if (ctx.role !== 'admin') {
    params.push(ctx.hotelIds);
    scope = `company_id = $1 AND hotel_id = ANY($${params.length}::bigint[])`;
  }
  const where = `${scope} AND ($2::bigint IS NULL OR hotel_id = $2) AND ($3::text IS NULL OR entity_type = $3) AND ($4::bigint IS NULL OR entity_id = $4)
     AND ($5::bigint IS NULL OR user_id = $5) AND ($6::text IS NULL OR action = $6) AND ($7::timestamptz IS NULL OR created_at >= $7) AND ($8::timestamptz IS NULL OR created_at <= $8)`;
  const total = (await maybeOne(db, `SELECT count(*)::int n FROM audit_logs WHERE ${where}`, params)).n;
  const list = await rows(db, `SELECT * FROM audit_logs WHERE ${where} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, q.limit, (q.page - 1) * q.limit]);
  return {
    data: list.map((r) => ({ id: r.id, hotelId: r.hotel_id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, userId: r.user_id, before: r.before, after: r.after, meta: r.meta, createdAt: r.created_at })),
    total,
  };
}
