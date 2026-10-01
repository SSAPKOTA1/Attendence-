import type { Request } from 'express';
import { Db, maybeOne, rows } from '../db/pool';
import { withTransaction, lockEmployees } from '../db/tx';
import { mapDbError } from '../db/errorMap';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { addDays, localDate, todayIn } from '../domain/dates';
import { shiftInstants } from '../domain/instants';
import { displayName } from '../domain/names';
import { workedMinutes } from '../domain/anomalies';
import { now } from '../clock';
import { checkIfMatch } from '../middleware/etag';
import { audit } from './audit';
import { getEmployeeAccess, Hotel, loadHotel, resolveHotelId } from './access';
import { managerIdsOfHotel, notify, userIdsOfEmployee } from './notifications';

export function correctionDto(c: any) {
  return {
    id: c.id,
    timeEntryId: c.time_entry_id,
    hotelId: c.hotel_id,
    employeeId: c.employee_id,
    proposedClockInAt: c.proposed_clock_in_at,
    proposedClockOutAt: c.proposed_clock_out_at,
    proposedBreakMinutes: c.proposed_break_minutes,
    reason: c.reason,
    status: c.status,
    decisionNote: c.decision_note,
    decidedById: c.decided_by_id,
    decidedAt: c.decided_at,
    originalClockInAt: c.original_clock_in_at,
    originalClockOutAt: c.original_clock_out_at,
    originalBreakMinutes: c.original_break_minutes,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

export function timeEntryDto(e: any, corrections?: any[]) {
  const dto: any = {
    id: e.id,
    hotelId: e.hotel_id,
    employeeId: e.employee_id,
    scheduleId: e.schedule_id,
    status: e.status,
    clockInAt: e.clock_in_at,
    clockOutAt: e.clock_out_at,
    breakMinutes: e.break_minutes,
    workedMinutes: workedMinutes(new Date(e.clock_in_at), e.clock_out_at ? new Date(e.clock_out_at) : null, e.break_minutes),
    sourceIn: e.source_in,
    sourceOut: e.source_out,
    anomalies: e.anomalies ?? [],
    note: e.note,
    unplannedReason: e.unplanned_reason,
    approvalStatus: e.approval_status,
    approvedById: e.approved_by_id,
    approvedAt: e.approved_at,
    approvalNote: e.approval_note,
    updatedAt: e.updated_at,
  };
  if (corrections) dto.corrections = corrections.map(correctionDto);
  return dto;
}

/** R13.9: entries whose local clock-in date is on/before the lock cannot change, except by an admin with a reason. */
function checkLock(hotel: Hotel, instants: (Date | null | undefined)[], ctx: AuthContext, reason?: string | null): boolean {
  if (!hotel.attendanceLockedUntil) return false;
  const locked = instants.some((i) => i && localDate(i, hotel.timezone) <= hotel.attendanceLockedUntil!);
  if (!locked) return false;
  if (ctx.role === 'admin' && reason && reason.trim()) return true;
  throw new AppError('PERIOD_LOCKED', { extra: { lockedUntil: hotel.attendanceLockedUntil } });
}

async function loadEntry(db: Db, ctx: AuthContext, id: number) {
  const e = await maybeOne(db, 'SELECT * FROM time_entries WHERE id = $1', [id]);
  if (!e) throw new AppError('RESOURCE_NOT_FOUND');
  const own = ctx.employeeId === e.employee_id;
  const managed = ctx.role !== 'staff' && ctx.hotelIds.includes(e.hotel_id);
  if (!own && !managed) throw new AppError('RESOURCE_NOT_FOUND');
  return { e, own, managed };
}

export async function getEntry(db: Db, ctx: AuthContext, id: number) {
  const { e } = await loadEntry(db, ctx, id);
  const corr = await rows(db, 'SELECT * FROM time_entry_corrections WHERE time_entry_id = $1 ORDER BY id', [id]);
  return timeEntryDto(e, corr);
}

export async function listEntries(
  db: Db,
  ctx: AuthContext,
  q: { hotelId?: number; from: string; to: string; employeeId?: string; status?: string; anomaly?: string; approvalStatus?: string },
) {
  let employeeFilter: number | null = null;
  let hotelId: number | null = null;
  if (ctx.role === 'staff' || q.employeeId === 'me') {
    if (!ctx.employeeId) throw new AppError('RESOURCE_NOT_FOUND');
    if (q.employeeId && q.employeeId !== 'me' && Number(q.employeeId) !== ctx.employeeId) throw new AppError('RESOURCE_NOT_FOUND');
    employeeFilter = ctx.employeeId;
    hotelId = q.hotelId ?? null;
  } else {
    hotelId = resolveHotelId(ctx, q.hotelId);
    employeeFilter = q.employeeId ? Number(q.employeeId) : null;
  }
  const list = await rows(
    db,
    `SELECT te.* FROM time_entries te JOIN hotels h ON h.id = te.hotel_id
      WHERE ($1::bigint IS NULL OR te.hotel_id = $1) AND ($2::bigint IS NULL OR te.employee_id = $2)
        AND (te.clock_in_at AT TIME ZONE h.timezone)::date BETWEEN $3 AND $4
        AND ($5::text IS NULL OR te.status = $5)
        AND ($6::text IS NULL OR te.anomalies @> jsonb_build_array(jsonb_build_object('type', $6::text)))
        AND ($7::text IS NULL OR te.approval_status = $7)
      ORDER BY te.clock_in_at`,
    [hotelId, employeeFilter, q.from, q.to, q.status ?? null, q.anomaly ?? null, q.approvalStatus ?? null],
  );
  return { data: list.map((e) => timeEntryDto(e)) };
}

async function findLinkableSchedule(db: Db, hotel: Hotel, employeeId: number, at: Date) {
  const d = localDate(at, hotel.timezone);
  const list = await rows(
    db,
    `SELECT s.id, s.date, sh.start_time, sh.end_time FROM schedules s JOIN shifts sh ON sh.id = s.shift_id
      WHERE s.employee_id = $1 AND s.hotel_id = $2 AND s.status = 'published' AND s.date BETWEEN $3 AND $4
        AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.schedule_id = s.id)`,
    [employeeId, hotel.id, addDays(d, -1), d],
  );
  for (const s of list) {
    const inst = shiftInstants(s.date, s.start_time, s.end_time, hotel.timezone);
    if (at.getTime() >= inst.start.getTime() - 2 * 3_600_000 && at <= inst.end) return s.id;
  }
  return null;
}

/** AT3: a manager adds a missed day (source manager, reason mandatory). */
export async function createManualEntry(
  ctx: AuthContext,
  input: { hotelId?: number; employeeId: number; clockInAt: Date; clockOutAt?: Date | null; breakMinutes?: number; reason: string },
) {
  const hotelId = resolveHotelId(ctx, input.hotelId);
  return withTransaction(async (db) => {
    const hotel = await loadHotel(db, hotelId);
    await getEmployeeAccess(db, ctx, input.employeeId);
    if (ctx.employeeId === input.employeeId && ctx.role !== 'admin') throw new AppError('FORBIDDEN', { details: [{ issue: 'you cannot decide your own request; another manager or an admin must' }] });
    await lockEmployees(db, [input.employeeId]);
    if (input.clockOutAt && input.clockOutAt <= input.clockInAt) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'clockOutAt', issue: 'must be after clockInAt' }] });
    if (input.clockInAt > now()) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'clockInAt', issue: 'must not be in the future' }] });
    const override = checkLock(hotel, [input.clockInAt], ctx, input.reason);
    const scheduleId = await findLinkableSchedule(db, hotel, input.employeeId, input.clockInAt);
    let r;
    try {
      r = await maybeOne(
        db,
        `INSERT INTO time_entries (hotel_id, employee_id, schedule_id, clock_in_at, clock_out_at, break_minutes, status, source_in, source_out, note, created_by_id, anomalies)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'manager',$8,$9,$10,$11) RETURNING *`,
        [hotelId, input.employeeId, scheduleId, input.clockInAt, input.clockOutAt ?? null, input.breakMinutes ?? 0,
          input.clockOutAt ? 'closed' : 'open', input.clockOutAt ? 'manager' : null, input.reason, ctx.userId,
          JSON.stringify(scheduleId ? [] : [{ type: 'unscheduled_work' }])],
      );
    } catch (err) {
      throw mapDbError(err, { timeEntrySource: 'manual' }) ?? err;
    }
    await audit(db, ctx, {
      action: 'attendance.manual_create', entityType: 'time_entry', entityId: r.id, hotelId,
      after: { employeeId: r.employee_id, clockInAt: r.clock_in_at, clockOutAt: r.clock_out_at, breakMinutes: r.break_minutes },
      meta: override ? { adminReason: input.reason, lockOverride: true } : {},
    });
    return timeEntryDto(r, []);
  });
}

async function applyCorrection(db: Db, entry: any, c: { proposed_clock_in_at: any; proposed_clock_out_at: any; proposed_break_minutes: any }) {
  const clockIn = c.proposed_clock_in_at ?? entry.clock_in_at;
  const clockOut = c.proposed_clock_out_at ?? entry.clock_out_at;
  const brk = c.proposed_break_minutes ?? entry.break_minutes;
  const status = clockOut ? 'closed' : entry.status;
  try {
    return await maybeOne(
      db,
      `UPDATE time_entries SET clock_in_at = $2, clock_out_at = $3, break_minutes = $4, status = $5,
              source_out = CASE WHEN $3::timestamptz IS NOT NULL AND clock_out_at IS DISTINCT FROM $3::timestamptz THEN 'manager' ELSE source_out END
        WHERE id = $1 RETURNING *`,
      [entry.id, clockIn, clockOut, brk, status],
    );
  } catch (err) {
    throw mapDbError(err, { timeEntrySource: 'manual' }) ?? err;
  }
}

/** AT4: a manager's direct change is an approved correction row with a snapshot of the original values. */
export async function managerChange(
  ctx: AuthContext,
  id: number,
  input: { clockInAt?: Date; clockOutAt?: Date | null; breakMinutes?: number; reason: string },
  req?: Request,
) {
  return withTransaction(async (db) => {
    const { e, managed, own } = await loadEntry(db, ctx, id);
    if (!managed) throw new AppError('FORBIDDEN');
    if (own && ctx.role !== 'admin') throw new AppError('FORBIDDEN', { details: [{ issue: 'you cannot decide your own request; another manager or an admin must' }] });
    if (req) checkIfMatch(req, e.updated_at);
    if (input.clockInAt === undefined && input.clockOutAt === undefined && input.breakMinutes === undefined) {
      throw new AppError('VALIDATION_ERROR', { details: [{ issue: 'nothing to change' }] });
    }
    const hotel = await loadHotel(db, e.hotel_id);
    const override = checkLock(hotel, [new Date(e.clock_in_at), input.clockInAt], ctx, input.reason);
    const t = now();
    const c = await maybeOne(
      db,
      `INSERT INTO time_entry_corrections (hotel_id, time_entry_id, employee_id, requested_by_id, proposed_clock_in_at, proposed_clock_out_at,
              proposed_break_minutes, reason, status, decided_by_id, decided_at, original_clock_in_at, original_clock_out_at, original_break_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved',$4,$9,$10,$11,$12) RETURNING *`,
      [e.hotel_id, e.id, e.employee_id, ctx.userId, input.clockInAt ?? null, input.clockOutAt ?? null, input.breakMinutes ?? null,
        input.reason, t, e.clock_in_at, e.clock_out_at, e.break_minutes],
    );
    const updated = await applyCorrection(db, e, c);
    await audit(db, ctx, {
      action: 'attendance.correction_direct', entityType: 'time_entry', entityId: e.id, hotelId: e.hotel_id,
      before: { clockInAt: e.clock_in_at, clockOutAt: e.clock_out_at, breakMinutes: e.break_minutes, status: e.status },
      after: { clockInAt: updated.clock_in_at, clockOutAt: updated.clock_out_at, breakMinutes: updated.break_minutes, status: updated.status },
      meta: { correctionId: c.id, ...(override ? { adminReason: input.reason, lockOverride: true } : {}) },
    });
    const corr = await rows(db, 'SELECT * FROM time_entry_corrections WHERE time_entry_id = $1 ORDER BY id', [e.id]);
    return timeEntryDto(updated, corr);
  });
}

/** AT5: correction request (employee) – reason mandatory. */
export async function requestCorrection(
  ctx: AuthContext,
  id: number,
  input: { proposedClockInAt?: Date; proposedClockOutAt?: Date; proposedBreakMinutes?: number; reason: string },
) {
  return withTransaction(async (db) => {
    const { e } = await loadEntry(db, ctx, id);
    if (input.proposedClockInAt === undefined && input.proposedClockOutAt === undefined && input.proposedBreakMinutes === undefined) {
      throw new AppError('VALIDATION_ERROR', { details: [{ issue: 'propose at least one change' }] });
    }
    const hotel = await loadHotel(db, e.hotel_id);
    checkLock(hotel, [new Date(e.clock_in_at), input.proposedClockInAt], ctx, null);
    const c = await maybeOne(
      db,
      `INSERT INTO time_entry_corrections (hotel_id, time_entry_id, employee_id, requested_by_id, proposed_clock_in_at, proposed_clock_out_at, proposed_break_minutes, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [e.hotel_id, e.id, e.employee_id, ctx.userId, input.proposedClockInAt ?? null, input.proposedClockOutAt ?? null, input.proposedBreakMinutes ?? null, input.reason],
    );
    await notify(db, { userIds: await managerIdsOfHotel(db, e.hotel_id), kind: 'correction_requested', params: { timeEntryId: e.id, employeeId: e.employee_id }, entityType: 'correction', entityId: c.id });
    await audit(db, ctx, { action: 'attendance.correction_request', entityType: 'correction', entityId: c.id, hotelId: e.hotel_id, meta: { timeEntryId: e.id } });
    return correctionDto(c);
  });
}

export async function listCorrections(db: Db, ctx: AuthContext, q: { hotelId?: number; status?: string; employeeId?: string }) {
  if (ctx.role === 'staff' || q.employeeId === 'me') {
    if (!ctx.employeeId) throw new AppError('RESOURCE_NOT_FOUND');
    const list = await rows(db, `SELECT * FROM time_entry_corrections WHERE employee_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY id DESC`, [ctx.employeeId, q.status ?? null]);
    return { data: list.map(correctionDto) };
  }
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const list = await rows(db, `SELECT * FROM time_entry_corrections WHERE hotel_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY id DESC`, [hotelId, q.status ?? null]);
  return { data: list.map(correctionDto) };
}

/** AT7: managers approve/reject; staff may only cancel their own pending request. */
export async function decideCorrection(
  ctx: AuthContext,
  id: number,
  input: { status: 'approved' | 'rejected' | 'cancelled'; decisionNote?: string | null; reason?: string | null },
  req?: Request,
) {
  return withTransaction(async (db) => {
    const c = await maybeOne(db, 'SELECT * FROM time_entry_corrections WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw new AppError('RESOURCE_NOT_FOUND');
    const own = ctx.employeeId === c.employee_id;
    const managed = ctx.role !== 'staff' && ctx.hotelIds.includes(c.hotel_id);
    if (!own && !managed) throw new AppError('RESOURCE_NOT_FOUND');
    if (req) checkIfMatch(req, c.updated_at);
    if (!managed && input.status !== 'cancelled') throw new AppError('FORBIDDEN');
    if (managed && own && ctx.role !== 'admin' && input.status !== 'cancelled') throw new AppError('FORBIDDEN', { details: [{ issue: 'you cannot decide your own request; another manager or an admin must' }] });
    if (c.status !== 'pending') throw new AppError('INVALID_STATUS_TRANSITION');
    const t = now();
    const e = await maybeOne(db, 'SELECT * FROM time_entries WHERE id = $1 FOR UPDATE', [c.time_entry_id]);
    let override = false;
    if (input.status === 'approved') {
      const hotel = await loadHotel(db, c.hotel_id);
      override = checkLock(hotel, [new Date(e.clock_in_at), c.proposed_clock_in_at ? new Date(c.proposed_clock_in_at) : null], ctx, input.reason ?? input.decisionNote ?? null);
      await applyCorrection(db, e, c);
      await db.query(
        `UPDATE time_entry_corrections SET original_clock_in_at = $2, original_clock_out_at = $3, original_break_minutes = $4 WHERE id = $1`,
        [c.id, e.clock_in_at, e.clock_out_at, e.break_minutes],
      );
    }
    const updated = await maybeOne(
      db,
      `UPDATE time_entry_corrections SET status = $2, decision_note = $3, decided_by_id = $4, decided_at = $5 WHERE id = $1 RETURNING *`,
      [c.id, input.status, input.decisionNote ?? null, ctx.userId, t],
    );
    if (managed && !own && input.status !== 'cancelled') {
      await notify(db, { userIds: await userIdsOfEmployee(db, c.employee_id), kind: 'correction_decided', params: { status: input.status, timeEntryId: c.time_entry_id }, entityType: 'correction', entityId: c.id });
    }
    await audit(db, ctx, {
      action: `attendance.correction_${input.status}`, entityType: 'correction', entityId: c.id, hotelId: c.hotel_id,
      before: input.status === 'approved' ? { clockInAt: e.clock_in_at, clockOutAt: e.clock_out_at, breakMinutes: e.break_minutes } : undefined,
      after: input.status === 'approved' ? { clockInAt: c.proposed_clock_in_at ?? e.clock_in_at, clockOutAt: c.proposed_clock_out_at ?? e.clock_out_at, breakMinutes: c.proposed_break_minutes ?? e.break_minutes } : undefined,
      meta: { timeEntryId: c.time_entry_id, ...(override ? { lockOverride: true, adminReason: input.reason ?? input.decisionNote } : {}) },
    });
    return correctionDto(updated);
  });
}

/**
 * AT12 (SPEC 1.12): a supervisor of the entry's hotel (or an admin) approves or rejects the hours of unplanned work.
 * Only closed entries can be decided; nobody decides their own hours (admins excepted); a rejection needs a note.
 * Decisions change payroll-relevant hours, so the period lock applies.
 */
export async function decideApproval(ctx: AuthContext, id: number, input: { status: 'approved' | 'rejected'; note?: string | null }) {
  return withTransaction(async (db) => {
    const { e, managed, own } = await loadEntry(db, ctx, id);
    if (!managed) throw new AppError('FORBIDDEN');
    if (own && ctx.role !== 'admin') throw new AppError('FORBIDDEN', { details: [{ issue: 'you cannot approve your own hours; another manager or an admin must' }] });
    if (e.approval_status === 'not_required') throw new AppError('INVALID_STATUS_TRANSITION', { details: [{ issue: 'this entry belongs to a planned shift and needs no approval' }] });
    if (e.status !== 'closed') throw new AppError('INVALID_STATUS_TRANSITION', { details: [{ issue: 'the hours are not final yet: the entry must be closed first' }] });
    if (e.approval_status === input.status) throw new AppError('INVALID_STATUS_TRANSITION', { details: [{ issue: `already ${input.status}` }] });
    const note = input.note?.trim() || null;
    if (input.status === 'rejected' && !note) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'note', issue: 'a rejection needs a note for the employee' }] });
    const hotel = await loadHotel(db, e.hotel_id);
    const override = checkLock(hotel, [new Date(e.clock_in_at)], ctx, note);
    const updated = await maybeOne(
      db,
      `UPDATE time_entries SET approval_status = $2, approved_by_id = $3, approved_at = $4, approval_note = $5 WHERE id = $1 RETURNING *`,
      [id, input.status, ctx.userId, now(), note],
    );
    await notify(db, { userIds: await userIdsOfEmployee(db, e.employee_id), kind: 'time_approval_decided', params: { status: input.status, timeEntryId: id }, entityType: 'time_entry', entityId: id });
    await audit(db, ctx, {
      action: `attendance.approval_${input.status}`, entityType: 'time_entry', entityId: id, hotelId: e.hotel_id,
      before: { approvalStatus: e.approval_status }, after: { approvalStatus: updated.approval_status },
      meta: { workedMinutes: workedMinutes(new Date(e.clock_in_at), new Date(e.clock_out_at), e.break_minutes), ...(override ? { lockOverride: true, adminReason: note } : {}) },
    });
    const corr = await rows(db, 'SELECT * FROM time_entry_corrections WHERE time_entry_id = $1 ORDER BY id', [id]);
    return timeEntryDto(updated, corr);
  });
}

/** AT8 live board. */
export async function liveBoard(db: Db, ctx: AuthContext, q: { hotelId?: number; departmentId?: number }) {
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const hotel = await loadHotel(db, hotelId);
  const t = now();
  const today = localDate(t, hotel.timezone);
  const tol = hotel.settings.attendance.lateToleranceMinutes;
  const name = (r: any) => ({ id: r.employee_id, displayName: displayName(r.first_name, r.last_name) });
  const open = await rows(
    db,
    `SELECT te.*, e.first_name, e.last_name, sh.name AS shift_name, sh.department_id,
            EXISTS (SELECT 1 FROM time_entry_breaks b WHERE b.time_entry_id = te.id AND b.break_end_at IS NULL) AS on_break
       FROM time_entries te JOIN employees e ON e.id = te.employee_id
       LEFT JOIN schedules s ON s.id = te.schedule_id LEFT JOIN shifts sh ON sh.id = s.shift_id
      WHERE te.hotel_id = $1 AND te.status IN ('open','needs_review') ORDER BY te.clock_in_at`,
    [hotelId],
  );
  const deptOk = (d: number | null) => !q.departmentId || d === q.departmentId;
  const clockedIn = open
    .filter((r) => r.status === 'open' && deptOk(r.department_id ?? null))
    .map((r) => ({ timeEntryId: r.id, employee: name(r), since: r.clock_in_at, onBreak: r.on_break, shift: r.shift_name ? { name: r.shift_name } : null, anomalies: r.anomalies }));
  const needsReview = open
    .filter((r) => r.status === 'needs_review')
    .map((r) => ({ timeEntryId: r.id, employee: name(r), openSince: r.clock_in_at }));
  const awaiting = await rows(
    db,
    `SELECT te.id, te.employee_id, te.clock_in_at, te.clock_out_at, te.unplanned_reason, e.first_name, e.last_name
       FROM time_entries te JOIN employees e ON e.id = te.employee_id
      WHERE te.hotel_id = $1 AND te.approval_status = 'pending' ORDER BY te.clock_in_at`,
    [hotelId],
  );
  const awaitingApproval = awaiting.map((r) => ({ timeEntryId: r.id, employee: name(r), clockInAt: r.clock_in_at, clockOutAt: r.clock_out_at, reason: r.unplanned_reason }));
  const shifts = await rows(
    db,
    `SELECT s.id, s.employee_id, s.date, e.first_name, e.last_name, e.attendance_required, sh.name, sh.start_time, sh.end_time, sh.department_id
       FROM schedules s JOIN shifts sh ON sh.id = s.shift_id JOIN employees e ON e.id = s.employee_id
      WHERE s.hotel_id = $1 AND s.status = 'published' AND s.entry_type = 'shift' AND s.date BETWEEN $2 AND $3
        AND ($4::bigint IS NULL OR sh.department_id = $4)`,
    [hotelId, addDays(today, -1), today, q.departmentId ?? null],
  );
  const expectedNotArrived = [];
  const noShows = [];
  // two batched lookups instead of two queries per scheduled shift
  const empIds = [...new Set(shifts.map((x) => x.employee_id))];
  const entries = empIds.length
    ? await rows(
        db,
        `SELECT employee_id, schedule_id, clock_in_at, clock_out_at FROM time_entries
          WHERE employee_id = ANY($1::bigint[]) AND clock_in_at > $2 AND clock_in_at < $3`,
        [empIds, new Date(t.getTime() - 3 * 86_400_000), new Date(t.getTime() + 86_400_000)],
      )
    : [];
  const absences = empIds.length
    ? await rows(
        db,
        `SELECT employee_id, start_date, end_date FROM time_offs
          WHERE employee_id = ANY($1::bigint[]) AND status = 'approved' AND start_date <= $3 AND end_date >= $2`,
        [empIds, addDays(today, -1), today],
      )
    : [];
  for (const s of shifts) {
    const inst = shiftInstants(s.date, s.start_time, s.end_time, hotel.timezone);
    if (s.date !== today && inst.end <= t) {
      // yesterday's shifts only matter while still running
      continue;
    }
    if (inst.start > t) continue;
    const windowStart = inst.start.getTime() - 2 * 3_600_000;
    const hasEntry = entries.some((e) => {
      if (e.employee_id !== s.employee_id) return false;
      if (e.schedule_id === s.id) return true;
      // any time entry overlapping [start − 2 h, end) counts as having arrived
      const inAt = new Date(e.clock_in_at).getTime();
      const outAt = e.clock_out_at ? new Date(e.clock_out_at).getTime() : Infinity;
      return inAt < inst.end.getTime() && outAt > windowStart;
    });
    if (hasEntry) continue;
    if (absences.some((x) => x.employee_id === s.employee_id && x.start_date <= s.date && x.end_date >= s.date)) continue;
    const minutesLate = Math.floor((t.getTime() - inst.start.getTime()) / 60_000);
    if (t.getTime() > inst.end.getTime() + tol * 60_000) {
      if (s.attendance_required) noShows.push({ scheduleId: s.id, employee: name(s), shift: { name: s.name, startTime: s.start_time, endTime: s.end_time } });
    } else if (minutesLate > 0) {
      expectedNotArrived.push({ scheduleId: s.id, employee: name(s), shift: { name: s.name, startTime: s.start_time }, minutesLate });
    }
  }
  return { serverTime: t.toISOString(), clockedIn, expectedNotArrived, noShows, needsReview, awaitingApproval };
}

/** AT9: managers may only move the lock forward; admins may move it back. */
export async function setLock(db: Db, ctx: AuthContext, hotelId: number, lockedUntil: string, reason?: string) {
  if (!ctx.hotelIds.includes(hotelId)) throw new AppError('RESOURCE_NOT_FOUND');
  const hotel = await loadHotel(db, hotelId);
  const current = hotel.attendanceLockedUntil;
  if (current && lockedUntil < current && ctx.role !== 'admin') {
    throw new AppError('FORBIDDEN', { details: [{ field: 'lockedUntil', issue: 'managers can only move the lock forward' }] });
  }
  await db.query('UPDATE hotels SET attendance_locked_until = $2 WHERE id = $1', [hotelId, lockedUntil]);
  await audit(db, ctx, { action: 'attendance.lock', entityType: 'hotel', entityId: hotelId, hotelId, before: { lockedUntil: current }, after: { lockedUntil }, meta: reason ? { adminReason: reason } : {} });
  return { hotelId, lockedUntil };
}

/** R13.7 job: entries open longer than needsReviewAfterHours become needs_review (never auto-closed). */
export async function markNeedsReview(db: Db): Promise<number> {
  const hotels = await rows(db, 'SELECT * FROM hotels WHERE deleted_at IS NULL');
  let total = 0;
  const t = now();
  for (const h of hotels) {
    const hotel = await loadHotel(db, h.id);
    const cutoff = new Date(t.getTime() - hotel.settings.attendance.needsReviewAfterHours * 3_600_000);
    const updated = await rows(
      db,
      `UPDATE time_entries SET status = 'needs_review' WHERE hotel_id = $1 AND status = 'open' AND clock_in_at < $2 RETURNING id, employee_id`,
      [h.id, cutoff],
    );
    total += updated.length;
    if (updated.length > 0) {
      const managers = await managerIdsOfHotel(db, h.id);
      for (const u of updated) {
        await notify(db, { userIds: managers, kind: 'needs_review_entry', params: { timeEntryId: u.id, employeeId: u.employee_id }, entityType: 'time_entry', entityId: u.id });
        await audit(db, null, { action: 'attendance.needs_review', entityType: 'time_entry', entityId: u.id, hotelId: h.id, companyId: h.company_id });
      }
    }
  }
  return total;
}

export { todayIn };
