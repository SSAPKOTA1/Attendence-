import type pg from 'pg';
import type { Request } from 'express';
import { Db, maybeOne, rows } from '../../db/pool';
import { lockEmployees, withTransaction } from '../../db/tx';
import { mapDbError } from '../../db/errorMap';
import { AppError } from '../../errors/AppError';
import type { AuthContext } from '../../types/context';
import { addDays, eachDate, isoWeekday, todayIn, weekEnd, weekStart } from '../../domain/dates';
import { hoursBetween } from '../../domain/instants';
import { toHours } from '../../domain/hours';
import { displayName } from '../../domain/names';
import { now } from '../../clock';
import { checkIfMatch } from '../../middleware/etag';
import { audit } from '../audit';
import { loadHotel, resolveHotelId } from '../access';
import { notify, userIdsOfEmployee } from '../notifications';
import { ENTRY_SELECT, Entry, loadEntryById, mapEntry } from './entries';
import { EntryInput, evaluateEntry, evaluationResponse, Evaluation, findHotelEmployees } from './evaluate';

export function entryDto(e: Entry, employee?: { id: number; first_name: string; last_name: string }, opts: { withWarnings?: boolean } = { withWarnings: true }) {
  const dto: any = {
    id: e.id,
    hotelId: e.hotelId,
    hotelName: e.hotelName,
    status: e.status,
    entryType: e.entryType,
    date: e.date,
    employee: employee ? { id: employee.id, firstName: employee.first_name, lastName: employee.last_name } : { id: e.employeeId },
    shift: e.entryType === 'shift'
      ? {
          id: e.shiftId,
          name: e.shiftName,
          departmentId: e.departmentId,
          startTime: e.startTime,
          endTime: e.endTime,
          durationHours: toHours(e.durationMinutes),
          breakDurationMinutes: e.breakMinutes,
          paidHours: toHours(e.paidMinutes),
        }
      : null,
    offLabel: e.offLabel,
    publishedAt: e.publishedAt,
    updatedAt: e.updatedAt,
  };
  if (opts.withWarnings) {
    dto.warnings = e.warnings;
    dto.overrideReason = e.overrideReason;
  }
  return dto;
}

function warningTypes(ev: Evaluation) {
  return ev.warnings.map((w) => w.type);
}

async function insertEntry(db: pg.PoolClient, ctx: AuthContext, input: EntryInput, ev: Evaluation): Promise<number> {
  try {
    const r = await maybeOne(
      db,
      `INSERT INTO schedules (hotel_id, employee_id, entry_type, shift_id, off_label, date, status, warnings, override_reason, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9) RETURNING id`,
      [input.hotelId, input.employeeId, input.entryType, input.entryType === 'shift' ? input.shiftId : null,
        input.entryType === 'off' ? input.offLabel ?? null : null, input.date, JSON.stringify(ev.warnings), input.overrideReason ?? null, ctx.userId],
    );
    return r.id;
  } catch (err) {
    throw mapDbError(err) ?? err;
  }
}

async function linkWish(db: Db, ctx: AuthContext, wishId: number, employeeId: number, scheduleId: number) {
  const w = await maybeOne(db, `SELECT * FROM employee_shift_wishes WHERE id = $1 AND employee_id = $2 AND status IN ('pending','approved')`, [wishId, employeeId]);
  if (!w) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'wishId' }] });
  await db.query(
    `UPDATE employee_shift_wishes SET status = 'approved', decided_by_id = COALESCE(decided_by_id, $2), decided_at = COALESCE(decided_at, $3), fulfilled_schedule_id = $4 WHERE id = $1`,
    [wishId, ctx.userId, now(), scheduleId],
  );
}

/** Creates one entry inside an open transaction (shared by POST, bulk and copy). */
export async function createInTx(db: pg.PoolClient, ctx: AuthContext, input: EntryInput & { wishId?: number }, meta: Record<string, unknown> = {}) {
  const ev = await evaluateEntry(db, ctx, input, { mode: 'create' });
  const id = await insertEntry(db, ctx, input, ev);
  if (input.wishId) await linkWish(db, ctx, input.wishId, input.employeeId, id);
  await audit(db, ctx, {
    action: 'schedule.create',
    entityType: 'schedule',
    entityId: id,
    hotelId: input.hotelId,
    after: { employeeId: input.employeeId, date: input.date, entryType: input.entryType, shiftId: input.shiftId ?? null, status: 'draft' },
    meta: {
      ...meta,
      warnings: warningTypes(ev),
      ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
      ...(ev.minorViolations.length ? { minorRules: ev.minorViolations.map((v) => v.rule) } : {}),
      ...(input.allowPast ? { allowPast: true } : {}),
    },
  });
  return { id, ev };
}

export async function createSchedule(ctx: AuthContext, body: Omit<EntryInput, 'hotelId'> & { hotelId?: number; wishId?: number }) {
  const hotelId = resolveHotelId(ctx, body.hotelId);
  return withTransaction(async (db) => {
    await lockEmployees(db, [body.employeeId]);
    const { id, ev } = await createInTx(db, ctx, { ...body, hotelId });
    return evaluationResponse(ev, { id });
  });
}

export async function validateSchedule(ctx: AuthContext, body: Omit<EntryInput, 'hotelId'> & { hotelId?: number }) {
  const hotelId = resolveHotelId(ctx, body.hotelId);
  return withTransaction(async (db) => {
    const ev = await evaluateEntry(db, ctx, { ...body, hotelId }, { mode: 'validate' });
    const out: any = evaluationResponse(ev);
    out.valid = true;
    out.overrideReasonRequired = ev.minorViolations.length > 0 && ev.hotel.settings.legal.minors.requireOverrideReason;
    return out;
  });
}

async function loadManagedEntry(db: Db, ctx: AuthContext, id: number, opts: { allowFloatingOff?: boolean } = {}): Promise<Entry> {
  const e = await loadEntryById(db, id);
  if (!e) throw new AppError('RESOURCE_NOT_FOUND');
  if (ctx.hotelIds.includes(e.hotelId)) return e;
  if (opts.allowFloatingOff && e.entryType === 'off') {
    const assignedHere = await maybeOne(
      db,
      'SELECT 1 FROM employee_hotels WHERE employee_id = $1 AND hotel_id = ANY($2::bigint[]) AND unassigned_on IS NULL',
      [e.employeeId, ctx.hotelIds],
    );
    if (assignedHere) return e;
  }
  throw new AppError('RESOURCE_NOT_FOUND');
}

function startOf(e: Entry): Date {
  return e.start;
}

async function notifyChange(db: Db, e: Entry, kind: 'roster_entry_changed' | 'roster_entry_removed', urgent: boolean, employeeId = e.employeeId) {
  if (e.status !== 'published') return;
  await notify(db, {
    userIds: await userIdsOfEmployee(db, employeeId),
    kind,
    params: { date: e.date, hotelId: e.hotelId },
    entityType: 'schedule',
    entityId: e.id,
    urgent,
  });
}

export async function updateSchedule(
  ctx: AuthContext,
  id: number,
  body: { shiftId?: number | null; employeeId?: number; offLabel?: string | null; date?: string; entryType?: 'shift' | 'off'; overrideReason?: string | null; allowPast?: boolean },
  req?: Request,
) {
  return withTransaction(async (db) => {
    const existing = await loadManagedEntry(db, ctx, id);
    if (req) checkIfMatch(req, existing.updatedAt);
    const hotel = await loadHotel(db, existing.hotelId);
    const today = todayIn(hotel.timezone, now());
    const allowPast = ctx.role === 'admin' && !!body.allowPast;
    if (existing.date < today && !allowPast) throw new AppError('SCHEDULE_DATE_IN_PAST', { details: [{ issue: 'past entries are immutable' }] });
    const entryType = body.entryType ?? (body.shiftId ? 'shift' : body.shiftId === null ? 'off' : existing.entryType);
    const input: EntryInput = {
      hotelId: existing.hotelId,
      entryType,
      employeeId: body.employeeId ?? existing.employeeId,
      shiftId: entryType === 'shift' ? body.shiftId ?? existing.shiftId : null,
      date: body.date ?? existing.date,
      offLabel: entryType === 'off' ? (body.offLabel === undefined ? existing.offLabel : body.offLabel) : null,
      overrideReason: body.overrideReason === undefined ? existing.overrideReason : body.overrideReason,
      allowPast,
    };
    await lockEmployees(db, [existing.employeeId, input.employeeId]);
    const ev = await evaluateEntry(db, ctx, input, { mode: 'update', existing });
    try {
      await db.query(
        `UPDATE schedules SET employee_id = $2, entry_type = $3, shift_id = $4, off_label = $5, date = $6, warnings = $7, override_reason = $8 WHERE id = $1`,
        [id, input.employeeId, input.entryType, input.shiftId, input.offLabel, input.date, JSON.stringify(ev.warnings), input.overrideReason ?? null],
      );
    } catch (err) {
      throw mapDbError(err) ?? err;
    }
    if (existing.employeeId !== input.employeeId) {
      await notifyChange(db, existing, 'roster_entry_removed', ev.shortNotice);
      await notifyChange(db, existing, 'roster_entry_changed', ev.shortNotice, input.employeeId);
    } else {
      await notifyChange(db, existing, 'roster_entry_changed', ev.shortNotice);
    }
    await audit(db, ctx, {
      action: 'schedule.update', entityType: 'schedule', entityId: id, hotelId: existing.hotelId,
      before: { employeeId: existing.employeeId, date: existing.date, entryType: existing.entryType, shiftId: existing.shiftId, status: existing.status },
      after: { employeeId: input.employeeId, date: input.date, entryType: input.entryType, shiftId: input.shiftId, status: existing.status },
      meta: { warnings: ev.warnings.map((w) => w.type), ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}), ...(allowPast ? { allowPast: true } : {}) },
    });
    const fresh = await loadEntryById(db, id);
    return evaluationResponse(ev, { id, updatedAt: fresh?.updatedAt });
  });
}

export async function deleteSchedule(ctx: AuthContext, id: number, allowPastParam = false) {
  return withTransaction(async (db) => {
    const e = await loadManagedEntry(db, ctx, id, { allowFloatingOff: true });
    const hotel = await loadHotel(db, e.hotelId);
    const allowPast = ctx.role === 'admin' && allowPastParam;
    if (e.date < todayIn(hotel.timezone, now()) && !allowPast) throw new AppError('SCHEDULE_DATE_IN_PAST', { details: [{ issue: 'past entries are immutable' }] });
    await lockEmployees(db, [e.employeeId]);
    const warnings: any[] = [];
    let urgent = false;
    if (e.status === 'published') {
      const hoursUntil = hoursBetween(now(), startOf(e));
      if (hoursUntil < hotel.settings.roster.changeNoticeHours) {
        urgent = true;
        warnings.push({
          type: 'short_notice_change',
          severity: 'warning',
          message: ctx.lang === 'de' ? `Änderung weniger als ${hotel.settings.roster.changeNoticeHours} Stunden vor Beginn` : `Change less than ${hotel.settings.roster.changeNoticeHours} hours before the start`,
          hoursBeforeStart: Math.round(hoursUntil * 100) / 100,
        });
      }
    }
    await db.query('DELETE FROM schedules WHERE id = $1', [id]);
    await notifyChange(db, e, 'roster_entry_removed', urgent);
    await audit(db, ctx, {
      action: 'schedule.delete', entityType: 'schedule', entityId: id, hotelId: e.hotelId,
      before: { employeeId: e.employeeId, date: e.date, entryType: e.entryType, shiftId: e.shiftId, status: e.status },
      meta: { warnings: warnings.map((w) => w.type), ...(allowPast ? { allowPast: true } : {}) },
    });
    return { id, warnings };
  });
}

// ---------------- reads ----------------
export async function getSchedule(db: Db, ctx: AuthContext, id: number) {
  const e = await loadEntryById(db, id);
  if (!e) throw new AppError('RESOURCE_NOT_FOUND');
  const emp = await maybeOne(db, 'SELECT id, first_name, last_name FROM employees WHERE id = $1', [e.employeeId]);
  if (ctx.role !== 'staff' && ctx.hotelIds.includes(e.hotelId)) return entryDto(e, emp);
  if (ctx.employeeId === e.employeeId && e.status === 'published') return entryDto(e, emp, { withWarnings: false });
  throw new AppError('RESOURCE_NOT_FOUND');
}

export async function listSchedules(
  db: Db,
  ctx: AuthContext,
  q: { hotelId?: number; from: string; to: string; departmentId?: number; employeeId?: string; status?: 'draft' | 'published' },
) {
  const isStaffView = ctx.role === 'staff';
  // own entries at all assigned hotels (portal)
  if (q.employeeId !== undefined && (q.employeeId === 'me' || (isStaffView && Number(q.employeeId) === ctx.employeeId))) {
    if (!ctx.employeeId) throw new AppError('RESOURCE_NOT_FOUND');
    const params: unknown[] = [ctx.employeeId, q.from, q.to];
    let hotelFilter = '';
    if (q.hotelId) {
      params.push(q.hotelId);
      hotelFilter = 'AND s.hotel_id = $4';
    }
    const statusFilter = isStaffView ? "AND s.status = 'published'" : q.status ? `AND s.status = '${q.status === 'draft' ? 'draft' : 'published'}'` : '';
    const list = (await rows(db, `${ENTRY_SELECT} WHERE s.employee_id = $1 AND s.date BETWEEN $2 AND $3 ${hotelFilter} ${statusFilter} ORDER BY s.date, sh.start_time`, params)).map(mapEntry);
    const emp = await maybeOne(db, 'SELECT id, first_name, last_name FROM employees WHERE id = $1', [ctx.employeeId]);
    return { data: list.map((e) => entryDto(e, emp, { withWarnings: !isStaffView })) };
  }
  if (isStaffView) {
    if (q.employeeId !== undefined) throw new AppError('RESOURCE_NOT_FOUND');
    return staffPlan(db, ctx, q);
  }
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const params: unknown[] = [hotelId, q.from, q.to, q.departmentId ?? null, q.employeeId ? Number(q.employeeId) : null, q.status ?? null];
  const list = await rows(
    db,
    `${ENTRY_SELECT}
      WHERE s.hotel_id = $1 AND s.date BETWEEN $2 AND $3
        AND ($4::bigint IS NULL OR sh.department_id = $4 OR (s.entry_type = 'off' AND EXISTS (
              SELECT 1 FROM employee_departments ed WHERE ed.employee_id = s.employee_id AND ed.department_id = $4)))
        AND ($5::bigint IS NULL OR s.employee_id = $5)
        AND ($6::text IS NULL OR s.status = $6)
      ORDER BY s.date, sh.start_time NULLS FIRST, s.id`,
    params,
  );
  const empIds = [...new Set(list.map((r) => r.employee_id))];
  const emps = new Map((await rows(db, 'SELECT id, first_name, last_name FROM employees WHERE id = ANY($1::bigint[])', [empIds])).map((e) => [e.id, e]));
  return { data: list.map((r) => entryDto(mapEntry(r), emps.get(r.employee_id))) };
}

/** Plan for staff (R15): published shifts only, never days off, names per portal.nameFormat, scope per planVisibility. */
async function staffPlan(db: Db, ctx: AuthContext, q: { hotelId?: number; from: string; to: string; departmentId?: number }) {
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const hotel = await loadHotel(db, hotelId);
  const vis = hotel.settings.portal.planVisibility;
  const myDepts = (await rows(db, 'SELECT department_id FROM employee_departments WHERE employee_id = $1 AND hotel_id = $2', [ctx.employeeId, hotelId])).map((r) => r.department_id);
  const params: unknown[] = [hotelId, q.from, q.to];
  let scope = '';
  if (vis === 'own_departments') {
    params.push(myDepts);
    scope = `AND sh.department_id = ANY($${params.length}::bigint[])`;
  } else if (vis === 'own_only') {
    params.push(ctx.employeeId);
    scope = `AND s.employee_id = $${params.length}`;
  }
  if (q.departmentId) {
    params.push(q.departmentId);
    scope += ` AND sh.department_id = $${params.length}`;
  }
  const list = await rows(
    db,
    `SELECT s.id, s.date, s.employee_id, e.first_name, e.last_name, sh.name AS shift_name, sh.start_time, sh.end_time,
            d.id AS department_id, d.name AS department_name
       FROM schedules s JOIN shifts sh ON sh.id = s.shift_id JOIN departments d ON d.id = sh.department_id
       JOIN employees e ON e.id = s.employee_id
      WHERE s.hotel_id = $1 AND s.date BETWEEN $2 AND $3 AND s.status = 'published' AND s.entry_type = 'shift' ${scope}
      ORDER BY s.date, sh.start_time, d.name, e.first_name`,
    params,
  );
  return {
    data: list.map((r) => ({
      date: r.date,
      department: { id: r.department_id, name: r.department_name },
      shift: { name: r.shift_name, startTime: r.start_time, endTime: r.end_time },
      employee: { displayName: displayName(r.first_name, r.last_name, hotel.settings.portal.nameFormat) },
      isMine: r.employee_id === ctx.employeeId,
    })),
  };
}

export async function coverage(db: Db, ctx: AuthContext, q: { hotelId?: number; from: string; to: string; departmentId?: number }) {
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const shifts = await rows(
    db,
    'SELECT id, name, department_id FROM shifts WHERE hotel_id = $1 AND deleted_at IS NULL AND ($2::bigint IS NULL OR department_id = $2) ORDER BY start_time, id',
    [hotelId, q.departmentId ?? null],
  );
  const reqs = await rows(db, 'SELECT shift_id, weekday, min_staff FROM shift_staffing_requirements WHERE hotel_id = $1', [hotelId]);
  const counts = await rows(
    db,
    `SELECT shift_id, date, count(*)::int AS n FROM schedules WHERE hotel_id = $1 AND entry_type = 'shift' AND date BETWEEN $2 AND $3 GROUP BY shift_id, date`,
    [hotelId, q.from, q.to],
  );
  const countMap = new Map(counts.map((c) => [`${c.shift_id}|${c.date}`, c.n]));
  const data = [];
  for (const date of eachDate(q.from, q.to)) {
    const wd = isoWeekday(date);
    for (const s of shifts) {
      const r = reqs.find((x) => x.shift_id === s.id && x.weekday === wd);
      const scheduled = countMap.get(`${s.id}|${date}`) ?? 0;
      const minStaff = r ? r.min_staff : null;
      data.push({ date, shiftId: s.id, shiftName: s.name, departmentId: s.department_id, scheduled, minStaff, understaffed: minStaff !== null && scheduled < minStaff });
    }
  }
  return { data };
}

/** R20 cover finder: read-only, nobody is contacted. */
export async function candidates(db: Db, ctx: AuthContext, q: { hotelId?: number; date: string; shiftId: number }) {
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const hotel = await loadHotel(db, hotelId);
  const shift = await maybeOne(db, 'SELECT * FROM shifts WHERE id = $1 AND hotel_id = $2 AND deleted_at IS NULL', [q.shiftId, hotelId]);
  if (!shift) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'shiftId' }] });
  const emps = await findHotelEmployees(db, hotelId, q.date);
  const out: any[] = [];
  for (const e of emps) {
    let ev: Evaluation;
    try {
      ev = await evaluateEntry(db, ctx, { hotelId, entryType: 'shift', employeeId: e.id, shiftId: shift.id, date: q.date }, { mode: 'candidate' });
    } catch (err) {
      if (err instanceof AppError) continue; // hard block: not a candidate
      throw err;
    }
    const wishRow = await maybeOne(
      db,
      `SELECT kind FROM employee_shift_wishes WHERE employee_id = $1 AND date = $2 AND status IN ('pending','approved')
          AND (shift_id = $3 OR (shift_id IS NULL AND kind = 'avoid')) ORDER BY (kind = 'avoid') DESC LIMIT 1`,
      [e.id, q.date, shift.id],
    );
    out.push({
      employee: { id: e.id, displayName: displayName(e.first_name, e.last_name, hotel.settings.portal.nameFormat) },
      isFloating: !e.is_home,
      weeklyHoursSoFar: toHours(ev.weekMinutesBefore),
      wish: wishRow ? wishRow.kind : null,
      minorWarning: ev.minorViolations.length > 0,
      warnings: ev.warnings,
    });
  }
  const significant = (c: any) => c.warnings.filter((w: any) => w.severity === 'warning').length;
  out.sort((a, b) => {
    const pa = a.wish === 'prefer' ? 0 : a.wish === 'avoid' ? 2 : 1;
    const pb = b.wish === 'prefer' ? 0 : b.wish === 'avoid' ? 2 : 1;
    if (pa !== pb) return pa - pb;
    const wa = significant(a) > 0 ? 1 : 0;
    const wb = significant(b) > 0 ? 1 : 0;
    if (wa !== wb) return wa - wb;
    return a.weeklyHoursSoFar - b.weeklyHoursSoFar;
  });
  return { data: out };
}

export { weekStart, weekEnd, addDays };
