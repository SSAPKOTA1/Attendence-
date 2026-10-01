import { Db, maybeOne, rows } from '../db/pool';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { durationMinutes, requiredBreak, toHours } from '../domain/hours';
import { todayIn } from '../domain/dates';
import { now } from '../clock';
import { audit } from './audit';
import { assertHotelAccess, loadHotel, resolveHotelId } from './access';

export function departmentDto(r: any) {
  return { id: r.id, hotelId: r.hotel_id, name: r.name, color: r.color, updatedAt: r.updated_at };
}

export function shiftDto(r: any, warnings?: unknown[]) {
  const duration = r.duration_minutes ?? durationMinutes(r.start_time, r.end_time);
  const dto: any = {
    id: r.id,
    hotelId: r.hotel_id,
    departmentId: r.department_id,
    name: r.name,
    startTime: r.start_time,
    endTime: r.end_time,
    durationHours: toHours(duration),
    breakDurationMinutes: r.break_duration_minutes,
    paidHours: toHours(duration - r.break_duration_minutes),
  };
  if (warnings) dto.warnings = warnings;
  return dto;
}

// ---------------- departments ----------------
export async function listDepartments(db: Db, ctx: AuthContext, q: { hotelId?: number; page: number; limit: number }) {
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const total = (await maybeOne(db, 'SELECT count(*)::int n FROM departments WHERE hotel_id = $1 AND deleted_at IS NULL', [hotelId])).n;
  const list = await rows(
    db,
    'SELECT * FROM departments WHERE hotel_id = $1 AND deleted_at IS NULL ORDER BY name LIMIT $2 OFFSET $3',
    [hotelId, q.limit, (q.page - 1) * q.limit],
  );
  return { data: list.map(departmentDto), total };
}

async function loadDepartment(db: Db, ctx: AuthContext, id: number) {
  const r = await maybeOne(db, 'SELECT * FROM departments WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!r || !ctx.hotelIds.includes(r.hotel_id)) throw new AppError('RESOURCE_NOT_FOUND');
  return r;
}

export async function getDepartment(db: Db, ctx: AuthContext, id: number) {
  return departmentDto(await loadDepartment(db, ctx, id));
}

export async function createDepartment(db: Db, ctx: AuthContext, input: { hotelId?: number; name: string; color?: string | null }) {
  const hotelId = resolveHotelId(ctx, input.hotelId);
  const r = await maybeOne(db, 'INSERT INTO departments (hotel_id, name, color) VALUES ($1,$2,$3) RETURNING *', [hotelId, input.name, input.color ?? null]);
  await audit(db, ctx, { action: 'department.create', entityType: 'department', entityId: r.id, hotelId });
  return departmentDto(r);
}

export async function updateDepartment(db: Db, ctx: AuthContext, id: number, input: { name?: string; color?: string | null }) {
  const d = await loadDepartment(db, ctx, id);
  const r = await maybeOne(db, 'UPDATE departments SET name = $2, color = $3 WHERE id = $1 RETURNING *', [
    id, input.name ?? d.name, input.color === undefined ? d.color : input.color,
  ]);
  await audit(db, ctx, { action: 'department.update', entityType: 'department', entityId: id, hotelId: d.hotel_id });
  return departmentDto(r);
}

export async function deleteDepartment(db: Db, ctx: AuthContext, id: number) {
  const d = await loadDepartment(db, ctx, id);
  const hotel = await loadHotel(db, d.hotel_id);
  const shifts = await maybeOne(db, 'SELECT 1 FROM shifts WHERE department_id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
  const future = await maybeOne(
    db,
    'SELECT 1 FROM schedules s JOIN shifts sh ON sh.id = s.shift_id WHERE sh.department_id = $1 AND s.date >= $2 LIMIT 1',
    [id, todayIn(hotel.timezone, now())],
  );
  if (shifts || future) throw new AppError('RESOURCE_IN_USE', { details: [{ field: 'departmentId', issue: shifts ? 'department still has shifts' : 'future roster entries exist' }] });
  await db.query('UPDATE departments SET deleted_at = now() WHERE id = $1', [id]);
  await audit(db, ctx, { action: 'department.delete', entityType: 'department', entityId: id, hotelId: d.hotel_id });
}

// ---------------- shifts ----------------
export function breakWarnings(settings: { legal: { breakRules: { grossOverHours: number; minMinutes: number }[] } }, start: string, end: string, breakMin: number, lang: 'de' | 'en' = 'en') {
  const gross = durationMinutes(start, end);
  const req = requiredBreak(gross, settings.legal.breakRules.map((r) => ({ overHours: r.grossOverHours, minMinutes: r.minMinutes })));
  if (breakMin < req) {
    return [{
      type: 'break_insufficient',
      severity: 'warning',
      message: lang === 'de' ? `Pause zu kurz: mindestens ${req} Minuten bei ${toHours(gross)} Stunden` : `Break too short: at least ${req} minutes required for ${toHours(gross)} hours`,
      requiredMinutes: req,
      actualMinutes: breakMin,
    }];
  }
  return [];
}

function validateShiftTimes(start: string, end: string, breakMin: number) {
  if (start === end) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'endTime', issue: 'start and end must differ' }] });
  if (breakMin >= durationMinutes(start, end)) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'breakDurationMinutes', issue: 'break must be shorter than the shift' }] });
  }
}

export async function listShifts(db: Db, ctx: AuthContext, q: { hotelId?: number; departmentId?: number; page: number; limit: number }) {
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const params = [hotelId, q.departmentId ?? null];
  const where = 'hotel_id = $1 AND deleted_at IS NULL AND ($2::bigint IS NULL OR department_id = $2)';
  const total = (await maybeOne(db, `SELECT count(*)::int n FROM shifts WHERE ${where}`, params)).n;
  const list = await rows(db, `SELECT * FROM shifts WHERE ${where} ORDER BY start_time, name LIMIT $3 OFFSET $4`, [...params, q.limit, (q.page - 1) * q.limit]);
  return { data: list.map((r) => shiftDto(r)), total };
}

export async function loadShift(db: Db, ctx: AuthContext, id: number) {
  const r = await maybeOne(db, 'SELECT * FROM shifts WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!r || !ctx.hotelIds.includes(r.hotel_id)) throw new AppError('RESOURCE_NOT_FOUND');
  return r;
}

export async function createShift(
  db: Db,
  ctx: AuthContext,
  input: { hotelId?: number; departmentId: number; name: string; startTime: string; endTime: string; breakDurationMinutes: number },
) {
  const hotelId = resolveHotelId(ctx, input.hotelId);
  const dept = await maybeOne(db, 'SELECT * FROM departments WHERE id = $1 AND hotel_id = $2 AND deleted_at IS NULL', [input.departmentId, hotelId]);
  if (!dept) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'departmentId', issue: 'not found in this hotel' }] });
  validateShiftTimes(input.startTime, input.endTime, input.breakDurationMinutes);
  const hotel = await loadHotel(db, hotelId);
  const r = await maybeOne(
    db,
    `INSERT INTO shifts (hotel_id, department_id, name, start_time, end_time, break_duration_minutes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [hotelId, input.departmentId, input.name, input.startTime, input.endTime, input.breakDurationMinutes],
  );
  await audit(db, ctx, { action: 'shift.create', entityType: 'shift', entityId: r.id, hotelId, after: { startTime: r.start_time, endTime: r.end_time, breakDurationMinutes: r.break_duration_minutes } });
  return shiftDto(r, breakWarnings(hotel.settings, r.start_time, r.end_time, r.break_duration_minutes, ctx.lang));
}

export async function updateShift(
  db: Db,
  ctx: AuthContext,
  id: number,
  input: { departmentId?: number; name?: string; startTime?: string; endTime?: string; breakDurationMinutes?: number },
) {
  const s = await loadShift(db, ctx, id);
  const departmentId = input.departmentId ?? s.department_id;
  if (input.departmentId) {
    const dept = await maybeOne(db, 'SELECT 1 FROM departments WHERE id = $1 AND hotel_id = $2 AND deleted_at IS NULL', [departmentId, s.hotel_id]);
    if (!dept) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'departmentId' }] });
  }
  const start = input.startTime ?? s.start_time;
  const end = input.endTime ?? s.end_time;
  const brk = input.breakDurationMinutes ?? s.break_duration_minutes;
  validateShiftTimes(start, end, brk);
  const hotel = await loadHotel(db, s.hotel_id);
  const r = await maybeOne(
    db,
    `UPDATE shifts SET department_id = $2, name = $3, start_time = $4, end_time = $5, break_duration_minutes = $6 WHERE id = $1 RETURNING *`,
    [id, departmentId, input.name ?? s.name, start, end, brk],
  );
  await audit(db, ctx, {
    action: 'shift.update', entityType: 'shift', entityId: id, hotelId: s.hotel_id,
    before: { startTime: s.start_time, endTime: s.end_time, breakDurationMinutes: s.break_duration_minutes },
    after: { startTime: r.start_time, endTime: r.end_time, breakDurationMinutes: r.break_duration_minutes },
  });
  return shiftDto(r, breakWarnings(hotel.settings, r.start_time, r.end_time, r.break_duration_minutes, ctx.lang));
}

export async function deleteShift(db: Db, ctx: AuthContext, id: number) {
  const s = await loadShift(db, ctx, id);
  const hotel = await loadHotel(db, s.hotel_id);
  const future = await maybeOne(db, 'SELECT 1 FROM schedules WHERE shift_id = $1 AND date >= $2 LIMIT 1', [id, todayIn(hotel.timezone, now())]);
  if (future) throw new AppError('RESOURCE_IN_USE', { details: [{ field: 'shiftId', issue: 'future roster entries exist' }] });
  await db.query('UPDATE shifts SET deleted_at = now() WHERE id = $1', [id]);
  await audit(db, ctx, { action: 'shift.delete', entityType: 'shift', entityId: id, hotelId: s.hotel_id });
}

export async function getStaffing(db: Db, ctx: AuthContext, shiftId: number) {
  const s = await loadShift(db, ctx, shiftId);
  assertHotelAccess(ctx, s.hotel_id);
  const list = await rows(db, 'SELECT weekday, min_staff FROM shift_staffing_requirements WHERE shift_id = $1 ORDER BY weekday', [shiftId]);
  return { shiftId, data: list.map((r) => ({ weekday: r.weekday, minStaff: r.min_staff })) };
}

export async function putStaffing(db: Db, ctx: AuthContext, shiftId: number, reqs: { weekday: number; minStaff: number }[]) {
  const s = await loadShift(db, ctx, shiftId);
  const days = new Set<number>();
  for (const r of reqs) {
    if (days.has(r.weekday)) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'weekday', issue: 'duplicate weekday' }] });
    days.add(r.weekday);
  }
  await db.query('DELETE FROM shift_staffing_requirements WHERE shift_id = $1', [shiftId]);
  for (const r of reqs) {
    await db.query('INSERT INTO shift_staffing_requirements (hotel_id, shift_id, weekday, min_staff) VALUES ($1,$2,$3,$4)', [s.hotel_id, shiftId, r.weekday, r.minStaff]);
  }
  await audit(db, ctx, { action: 'shift.staffing_update', entityType: 'shift', entityId: shiftId, hotelId: s.hotel_id, after: reqs });
  return getStaffing(db, ctx, shiftId);
}
