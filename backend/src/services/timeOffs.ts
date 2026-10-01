import { Db, maybeOne, rows } from '../db/pool';
import { withTransaction } from '../db/tx';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { addDays, monthStart, todayIn } from '../domain/dates';
import { countTimeOffDays } from '../domain/timeOffDays';
import { now } from '../clock';
import { audit } from './audit';
import { EmployeeAccess, getEmployeeAccess, homeHotelOf, resolveHotelId } from './access';
import { computeAllowance } from './allowance';
import { holidayName } from './holidays';
import { managerIdsOfHotel, notify, userIdsOfEmployee } from './notifications';
import { checkIfMatch } from '../middleware/etag';
import type { Request } from 'express';

export type TimeOffType = 'annual_leave' | 'sick_leave' | 'unpaid_leave' | 'school' | 'other';

export interface TimeOffInput {
  type: TimeOffType;
  startDate: string;
  endDate: string;
  startHalfDay?: boolean;
  endHalfDay?: boolean;
  reason?: string | null;
  status?: 'pending' | 'approved';
  unassignConflicts?: boolean;
  leaveWishId?: number;
  overrideReason?: string;
}

export function timeOffDto(r: any) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    type: r.type,
    startDate: r.start_date,
    endDate: r.end_date,
    startHalfDay: r.start_half_day,
    endHalfDay: r.end_half_day,
    timeOffDays: r.time_off_days,
    reason: r.reason,
    status: r.status,
    medicalCertificateReceived: r.medical_certificate_received,
    decidedById: r.decided_by_id,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function reducedDto(r: any) {
  return { employeeId: r.employee_id, startDate: r.start_date, endDate: r.end_date, status: 'unavailable' };
}

function validateShape(input: Pick<TimeOffInput, 'type' | 'startDate' | 'endDate' | 'startHalfDay' | 'endHalfDay' | 'reason'>) {
  if (input.endDate < input.startDate) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'endDate', issue: 'must not be before startDate' }] });
  if (input.startDate === input.endDate && input.startHalfDay && input.endHalfDay) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'endHalfDay', issue: 'a single day cannot have both half-day flags' }] });
  }
  if (input.type === 'sick_leave' && input.reason !== undefined && input.reason !== null) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'reason', issue: 'no reason may be stored for sick leave' }] });
  }
}

async function expand(db: Db, access: EmployeeAccess, input: Pick<TimeOffInput, 'startDate' | 'endDate' | 'startHalfDay' | 'endHalfDay'>, lang: 'de' | 'en' = 'de') {
  const home = await homeHotelOf(db, access.employeeId);
  const region = home?.holidayRegion ?? 'DE-HE';
  return countTimeOffDays({
    startDate: input.startDate,
    endDate: input.endDate,
    startHalfDay: input.startHalfDay,
    endHalfDay: input.endHalfDay,
    workWeekdays: access.employee.work_weekdays,
    // employees without public holidays off work normally on holidays: those days count as absence days
    holidayName: (d) => (access.employee.public_holidays_off ? holidayName(region, d, lang) : null),
  });
}

async function conflictsOf(db: Db, employeeId: number, from: string, to: string) {
  return rows(
    db,
    `SELECT s.id, s.date, s.status, s.hotel_id, h.name AS hotel_name, s.entry_type FROM schedules s JOIN hotels h ON h.id = s.hotel_id
      WHERE s.employee_id = $1 AND s.date BETWEEN $2 AND $3 ORDER BY s.date, s.id`,
    [employeeId, from, to],
  );
}

async function blackoutsFor(db: Db, homeHotelId: number | null, from: string, to: string) {
  if (!homeHotelId) return [];
  return rows(
    db,
    `SELECT * FROM leave_blackouts WHERE hotel_id = $1 AND deleted_at IS NULL AND start_date <= $3 AND end_date >= $2 ORDER BY start_date`,
    [homeHotelId, from, to],
  );
}

/** Per-year allowance check for annual leave (pending requests already reserve days). */
async function allowanceCheck(db: Db, employeeId: number, days: { date: string; fraction: number }[], excludeTimeOffId?: number) {
  const perYear = new Map<number, number>();
  for (const d of days) perYear.set(Number(d.date.slice(0, 4)), (perYear.get(Number(d.date.slice(0, 4))) ?? 0) + d.fraction);
  const out = [];
  for (const [year, requested] of [...perYear.entries()].sort()) {
    const a = await computeAllowance(db, employeeId, year);
    let reserved = a.pendingDays;
    if (excludeTimeOffId) {
      const own = await maybeOne(
        db,
        `SELECT COALESCE(SUM(day_fraction),0)::float n FROM time_off_dates WHERE time_off_id = $1 AND EXTRACT(YEAR FROM date) = $2`,
        [excludeTimeOffId, year],
      );
      reserved -= own.n;
    }
    const available = a.remainingDays - reserved;
    out.push({ year, requested, available, remainingBefore: available, remainingAfter: available - requested });
  }
  return out;
}

function blackoutWarnings(list: any[]) {
  return list.map((b) => ({ type: 'leave_blackout', severity: 'warning', reason: b.reason, mode: b.mode, startDate: b.start_date, endDate: b.end_date }));
}

async function previewInternal(db: Db, ctx: AuthContext, access: EmployeeAccess, input: TimeOffInput) {
  validateShape(input);
  const counted = await expand(db, access, input, ctx.lang);
  const conflicts = await conflictsOf(db, access.employeeId, input.startDate, input.endDate);
  const blackouts = input.type === 'annual_leave' ? await blackoutsFor(db, access.homeHotelId, input.startDate, input.endDate) : [];
  const allowances = input.type === 'annual_leave' && counted.total > 0 ? await allowanceCheck(db, access.employeeId, counted.days) : [];
  return { counted, conflicts, blackouts, allowances };
}

export async function preview(db: Db, ctx: AuthContext, input: TimeOffInput & { employeeId: number | 'me' }) {
  const access = await getEmployeeAccess(db, ctx, input.employeeId);
  if (!access.fullView) throw new AppError('FORBIDDEN');
  const p = await previewInternal(db, ctx, access, input);
  const first = p.allowances[0];
  return {
    employeeId: access.employeeId,
    type: input.type,
    timeOffDays: p.counted.total,
    days: p.counted.days,
    skipped: p.counted.skipped,
    allowance: first ? { year: first.year, remainingBefore: first.remainingBefore, remainingAfter: first.remainingAfter } : null,
    allowances: p.allowances.map((a) => ({ year: a.year, remainingBefore: a.remainingBefore, remainingAfter: a.remainingAfter })),
    conflicts: { scheduleIds: p.conflicts.map((c) => c.id) },
    warnings: blackoutWarnings(p.blackouts),
  };
}

/** Deletes conflicting roster entries at any hotel (R6 cross-hotel precedence), audited. */
async function unassign(db: Db, ctx: AuthContext, conflicts: any[], timeOffId: number | null) {
  for (const c of conflicts) {
    await db.query('DELETE FROM schedules WHERE id = $1', [c.id]);
    await audit(db, ctx, {
      action: 'schedule.delete', entityType: 'schedule', entityId: c.id, hotelId: c.hotel_id,
      before: { date: c.date, status: c.status, entryType: c.entry_type }, meta: { cause: 'absence_unassign', timeOffId },
    });
  }
  if (conflicts.length > 0) {
    const employeeId = (await maybeOne(db, 'SELECT employee_id FROM time_offs WHERE id = $1', [timeOffId]))?.employee_id;
    const published = conflicts.filter((c) => c.status === 'published');
    if (employeeId && published.length > 0) {
      await notify(db, {
        userIds: await userIdsOfEmployee(db, employeeId),
        kind: 'roster_entry_removed',
        params: { dates: published.map((c) => c.date) },
        entityType: 'time_off',
        entityId: timeOffId,
      });
    }
  }
}

function conflictDetails(conflicts: any[]) {
  return conflicts.map((c) => ({ scheduleId: c.id, date: c.date, hotelId: c.hotel_id, hotelName: c.hotel_name }));
}

export async function createTimeOff(ctx: AuthContext, employeeParam: string | number, input: TimeOffInput) {
  return withTransaction(async (db) => {
    const access = await getEmployeeAccess(db, ctx, employeeParam);
    const actsAsManager = access.isHomeManager && ctx.role !== 'staff';
    if (!actsAsManager && !access.isSelf) throw new AppError('FORBIDDEN', { details: [{ issue: "absences are decided by the employee's home hotel" }] });
    if (!actsAsManager && input.type === 'school') throw new AppError('FORBIDDEN', { details: [{ field: 'type', issue: 'school days are entered by managers' }] });
    if (!actsAsManager && input.unassignConflicts) throw new AppError('FORBIDDEN', { details: [{ field: 'unassignConflicts' }] });
    // four-eyes: managers cannot approve their own absences (admins excepted)
    const selfManaged = access.isSelf && ctx.role !== 'admin';
    const status = actsAsManager && !selfManaged ? (input.status ?? 'approved') : 'pending';
    await db.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [access.employeeId]);
    const p = await previewInternal(db, ctx, access, input);
    if (p.counted.total === 0) throw new AppError('NO_WORKING_DAYS_IN_RANGE');
    if (input.type === 'annual_leave') {
      const exceeded = p.allowances.filter((a) => a.requested > a.available);
      if (exceeded.length > 0) {
        throw new AppError('ALLOWANCE_EXCEEDED', { details: exceeded.map((a) => ({ year: a.year, requested: a.requested, available: a.available })) });
      }
    }
    const blocking = p.blackouts.filter((b) => b.mode === 'block');
    if (blocking.length > 0 && !(actsAsManager && input.overrideReason)) {
      throw new AppError('LEAVE_BLACKOUT', { details: blocking.map((b) => ({ startDate: b.start_date, endDate: b.end_date, reason: b.reason })) });
    }
    let conflicts = p.conflicts;
    let removed: any[] = [];
    if (status === 'approved' && conflicts.length > 0) {
      if (input.unassignConflicts) {
        removed = conflicts;
      } else if (input.type !== 'sick_leave') {
        throw new AppError('TIME_OFF_CONFLICTS_WITH_SCHEDULE', { details: conflictDetails(conflicts) });
      }
    }
    const t = now();
    const r = await maybeOne(
      db,
      `INSERT INTO time_offs (employee_id, start_date, end_date, start_half_day, end_half_day, time_off_days, type, reason, status,
                              created_by_id, decided_by_id, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [access.employeeId, input.startDate, input.endDate, !!input.startHalfDay, !!input.endHalfDay, p.counted.total, input.type,
        input.type === 'sick_leave' ? null : input.reason ?? null, status, ctx.userId,
        status === 'approved' ? ctx.userId : null, status === 'approved' ? t : null],
    );
    for (const d of p.counted.days) {
      await db.query('INSERT INTO time_off_dates (time_off_id, employee_id, date, day_fraction) VALUES ($1,$2,$3,$4)', [r.id, access.employeeId, d.date, d.fraction]);
    }
    if (removed.length > 0) {
      await unassign(db, ctx, removed, r.id);
      conflicts = removed;
    }
    if (input.leaveWishId) {
      const w = await maybeOne(db, `SELECT * FROM employee_leave_wishes WHERE id = $1 AND employee_id = $2 AND status IN ('pending','approved')`, [input.leaveWishId, access.employeeId]);
      if (!w) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'leaveWishId' }] });
      await db.query(
        `UPDATE employee_leave_wishes SET status = 'approved', decided_by_id = COALESCE(decided_by_id, $2), decided_at = COALESCE(decided_at, $3), fulfilled_time_off_id = $4 WHERE id = $1`,
        [w.id, ctx.userId, t, r.id],
      );
    }
    await audit(db, ctx, {
      action: 'time_off.create', entityType: 'time_off', entityId: r.id, hotelId: access.homeHotelId,
      after: { type: r.type, startDate: r.start_date, endDate: r.end_date, status: r.status, timeOffDays: r.time_off_days, unassigned: removed.map((c) => c.id) },
      meta: input.overrideReason ? { overrideReason: input.overrideReason, blackouts: blocking.map((b) => b.id) } : undefined,
    });
    if (access.homeHotelId) {
      const managers = await managerIdsOfHotel(db, access.homeHotelId);
      if (input.type === 'sick_leave' && !actsAsManager) {
        await notify(db, { userIds: managers, kind: 'sick_reported', params: { employeeId: access.employeeId, startDate: r.start_date, endDate: r.end_date }, entityType: 'time_off', entityId: r.id });
      } else if (status === 'pending') {
        await notify(db, { userIds: managers, kind: 'absence_requested', params: { employeeId: access.employeeId, startDate: r.start_date, endDate: r.end_date }, entityType: 'time_off', entityId: r.id });
      }
    }
    if (actsAsManager && !access.isSelf) {
      await notify(db, { userIds: await userIdsOfEmployee(db, access.employeeId), kind: 'absence_decided', params: { status, startDate: r.start_date, endDate: r.end_date }, entityType: 'time_off', entityId: r.id });
    }
    return {
      ...timeOffDto(r),
      days: p.counted.days,
      conflicts: input.type === 'sick_leave' || removed.length > 0 ? conflicts.map((c) => c.id) : [],
      conflictDetails: conflictDetails(conflicts),
      warnings: blackoutWarnings(p.blackouts),
    };
  });
}

async function loadTimeOff(db: Db, ctx: AuthContext, id: number) {
  const r = await maybeOne(db, 'SELECT * FROM time_offs WHERE id = $1', [id]);
  if (!r) throw new AppError('RESOURCE_NOT_FOUND');
  const access = await getEmployeeAccess(db, ctx, r.employee_id);
  if (!access.fullView) throw new AppError('RESOURCE_NOT_FOUND');
  return { r, access };
}

export async function getTimeOff(db: Db, ctx: AuthContext, id: number) {
  const { r } = await loadTimeOff(db, ctx, id);
  return timeOffDto(r);
}

const TRANSITIONS: Record<string, string[]> = {
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['cancelled'],
  rejected: [],
  cancelled: [],
};

export async function updateTimeOff(
  ctx: AuthContext,
  id: number,
  input: {
    status?: 'approved' | 'rejected' | 'cancelled';
    unassignConflicts?: boolean;
    medicalCertificateReceived?: boolean;
    startDate?: string;
    endDate?: string;
    startHalfDay?: boolean;
    endHalfDay?: boolean;
    reason?: string | null;
  },
  req?: Request,
) {
  return withTransaction(async (db) => {
    const { r, access } = await loadTimeOff(db, ctx, id);
    if (req) checkIfMatch(req, r.updated_at);
    await db.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [access.employeeId]);
    const asManager = access.isHomeManager && ctx.role !== 'staff';
    if (asManager && access.isSelf && ctx.role !== 'admin' && (input.status === 'approved' || input.status === 'rejected' || input.medicalCertificateReceived !== undefined)) {
      throw new AppError('FORBIDDEN', { details: [{ issue: 'you cannot decide your own request; another manager or an admin must' }] });
    }
    if (!asManager) {
      const onlyCancel = input.status === 'cancelled' && Object.keys(input).every((k) => k === 'status');
      if (!onlyCancel) throw new AppError('FORBIDDEN', { details: [{ issue: 'staff may only withdraw their own pending requests' }] });
      if (r.status !== 'pending') throw new AppError('INVALID_STATUS_TRANSITION');
    }
    const t = now();
    let row = r;
    const before = timeOffDto(r);
    // date edits (pending only)
    if (input.startDate || input.endDate || input.startHalfDay !== undefined || input.endHalfDay !== undefined || input.reason !== undefined) {
      if (r.status !== 'pending') throw new AppError('INVALID_STATUS_TRANSITION', { details: [{ issue: 'only pending absences can be edited' }] });
      const next = {
        type: r.type,
        startDate: input.startDate ?? r.start_date,
        endDate: input.endDate ?? r.end_date,
        startHalfDay: input.startHalfDay ?? r.start_half_day,
        endHalfDay: input.endHalfDay ?? r.end_half_day,
        reason: input.reason === undefined ? r.reason : input.reason,
      };
      validateShape(next);
      const counted = await expand(db, access, next, ctx.lang);
      if (counted.total === 0) throw new AppError('NO_WORKING_DAYS_IN_RANGE');
      if (r.type === 'annual_leave') {
        const checks = await allowanceCheck(db, access.employeeId, counted.days, r.id);
        const exceeded = checks.filter((a) => a.requested > a.available);
        if (exceeded.length > 0) throw new AppError('ALLOWANCE_EXCEEDED', { details: exceeded.map((a) => ({ year: a.year, requested: a.requested, available: a.available })) });
      }
      row = await maybeOne(
        db,
        `UPDATE time_offs SET start_date=$2, end_date=$3, start_half_day=$4, end_half_day=$5, time_off_days=$6, reason=$7 WHERE id=$1 RETURNING *`,
        [r.id, next.startDate, next.endDate, next.startHalfDay, next.endHalfDay, counted.total, r.type === 'sick_leave' ? null : next.reason],
      );
      await db.query('DELETE FROM time_off_dates WHERE time_off_id = $1', [r.id]);
      for (const d of counted.days) {
        await db.query('INSERT INTO time_off_dates (time_off_id, employee_id, date, day_fraction) VALUES ($1,$2,$3,$4)', [r.id, access.employeeId, d.date, d.fraction]);
      }
    }
    let conflicts: any[] = [];
    if (input.status && input.status !== row.status) {
      if (!TRANSITIONS[row.status].includes(input.status)) throw new AppError('INVALID_STATUS_TRANSITION');
      if (input.status === 'approved') {
        conflicts = await conflictsOf(db, access.employeeId, row.start_date, row.end_date);
        if (conflicts.length > 0) {
          if (input.unassignConflicts) await unassign(db, ctx, conflicts, row.id);
          else if (row.type !== 'sick_leave') throw new AppError('TIME_OFF_CONFLICTS_WITH_SCHEDULE', { details: conflictDetails(conflicts) });
        }
      }
      row = await maybeOne(
        db,
        `UPDATE time_offs SET status = $2, decided_by_id = $3, decided_at = $4 WHERE id = $1 RETURNING *`,
        [row.id, input.status, asManager ? ctx.userId : row.decided_by_id, asManager ? t : row.decided_at],
      );
      if (asManager && !access.isSelf) {
        await notify(db, {
          userIds: await userIdsOfEmployee(db, access.employeeId),
          kind: 'absence_decided',
          params: { status: input.status, startDate: row.start_date, endDate: row.end_date },
          entityType: 'time_off',
          entityId: row.id,
        });
      }
    }
    if (input.medicalCertificateReceived !== undefined) {
      if (!asManager) throw new AppError('FORBIDDEN');
      if (row.type !== 'sick_leave') throw new AppError('VALIDATION_ERROR', { details: [{ field: 'medicalCertificateReceived', issue: 'only for sick leave' }] });
      row = await maybeOne(db, 'UPDATE time_offs SET medical_certificate_received = $2 WHERE id = $1 RETURNING *', [row.id, input.medicalCertificateReceived]);
    }
    const action = input.status === 'approved' ? 'time_off.approve' : input.status === 'rejected' ? 'time_off.reject' : input.status === 'cancelled' ? 'time_off.cancel' : 'time_off.update';
    await audit(db, ctx, { action, entityType: 'time_off', entityId: row.id, hotelId: access.homeHotelId, before, after: timeOffDto(row), meta: { unassigned: input.unassignConflicts ? conflicts.map((c) => c.id) : [] } });
    return { ...timeOffDto(row), conflicts: conflicts.map((c) => c.id), conflictDetails: conflictDetails(conflicts) };
  });
}

export async function cancelTimeOff(ctx: AuthContext, id: number) {
  await updateTimeOff(ctx, id, { status: 'cancelled' });
}

export async function listForHotel(
  db: Db,
  ctx: AuthContext,
  q: { hotelId?: number; from?: string; to?: string; type?: string; status?: string },
) {
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const today = todayIn('Europe/Berlin', now());
  const from = q.from ?? monthStart(today);
  const to = q.to ?? addDays(from, 61);
  const list = await rows(
    db,
    `SELECT t.*, home.hotel_id AS home_hotel_id
       FROM time_offs t
       JOIN employee_hotels eh ON eh.employee_id = t.employee_id AND eh.hotel_id = $1 AND (eh.unassigned_on IS NULL OR eh.unassigned_on >= $2::date)
       LEFT JOIN employee_hotels home ON home.employee_id = t.employee_id AND home.is_home
      WHERE t.start_date <= $3 AND t.end_date >= $2
      ORDER BY t.start_date, t.id`,
    [hotelId, from, to],
  );
  const data = [];
  for (const r of list) {
    const full = ctx.role === 'admin' || ctx.hotelIds.includes(r.home_hotel_id);
    if (full) {
      if (q.type && r.type !== q.type) continue;
      if (q.status && r.status !== q.status) continue;
      data.push(timeOffDto(r));
    } else if (r.status === 'approved') {
      data.push(reducedDto(r));
    }
  }
  return { data, from, to };
}

export async function listForEmployee(db: Db, ctx: AuthContext, param: string | number, q: { year?: number; from?: string; to?: string; status?: string }) {
  const access = await getEmployeeAccess(db, ctx, param);
  const today = todayIn('Europe/Berlin', now());
  const from = q.from ?? `${q.year ?? today.slice(0, 4)}-01-01`;
  const to = q.to ?? `${q.year ?? today.slice(0, 4)}-12-31`;
  const list = await rows(
    db,
    `SELECT * FROM time_offs WHERE employee_id = $1 AND start_date <= $3 AND end_date >= $2 AND ($4::text IS NULL OR status = $4) ORDER BY start_date, id`,
    [access.employeeId, from, to, q.status ?? null],
  );
  if (access.fullView) return { data: list.map(timeOffDto) };
  return { data: list.filter((r) => r.status === 'approved').map(reducedDto) };
}

// ---------------- blackouts ----------------
export function blackoutDto(r: any) {
  return { id: r.id, hotelId: r.hotel_id, startDate: r.start_date, endDate: r.end_date, reason: r.reason, mode: r.mode };
}

export async function listBlackouts(db: Db, ctx: AuthContext, q: { hotelId?: number; year?: number }) {
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const year = q.year ?? Number(todayIn('Europe/Berlin', now()).slice(0, 4));
  const list = await rows(
    db,
    `SELECT * FROM leave_blackouts WHERE hotel_id = $1 AND deleted_at IS NULL AND start_date <= $3 AND end_date >= $2 ORDER BY start_date`,
    [hotelId, `${year}-01-01`, `${year}-12-31`],
  );
  return { data: list.map(blackoutDto) };
}

export async function createBlackout(db: Db, ctx: AuthContext, input: { hotelId?: number; startDate: string; endDate: string; reason: string; mode: 'warn' | 'block' }) {
  const hotelId = resolveHotelId(ctx, input.hotelId);
  if (input.endDate < input.startDate) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'endDate', issue: 'must not be before startDate' }] });
  const r = await maybeOne(
    db,
    'INSERT INTO leave_blackouts (hotel_id, start_date, end_date, reason, mode, created_by_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [hotelId, input.startDate, input.endDate, input.reason, input.mode, ctx.userId],
  );
  await audit(db, ctx, { action: 'leave_blackout.create', entityType: 'leave_blackout', entityId: r.id, hotelId, after: { startDate: r.start_date, endDate: r.end_date, mode: r.mode } });
  return blackoutDto(r);
}

export async function deleteBlackout(db: Db, ctx: AuthContext, id: number) {
  const r = await maybeOne(db, 'SELECT * FROM leave_blackouts WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!r || !ctx.hotelIds.includes(r.hotel_id)) throw new AppError('RESOURCE_NOT_FOUND');
  await db.query('UPDATE leave_blackouts SET deleted_at = now() WHERE id = $1', [id]);
  await audit(db, ctx, { action: 'leave_blackout.delete', entityType: 'leave_blackout', entityId: id, hotelId: r.hotel_id });
}
