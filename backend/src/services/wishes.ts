import { Db, maybeOne, rows } from '../db/pool';
import { mapDbError } from '../db/errorMap';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { addDays, eachDate, isoWeekday, todayIn } from '../domain/dates';
import { countTimeOffDays } from '../domain/timeOffDays';
import { displayName } from '../domain/names';
import { now } from '../clock';
import { audit } from './audit';
import { getEmployeeAccess, homeHotelOf, loadHotel, resolveHotelId } from './access';
import { holidayName } from './holidays';
import { managerIdsOfHotel, notify, userIdsOfEmployee } from './notifications';

export function shiftWishDto(r: any) {
  return {
    id: r.id,
    hotelId: r.hotel_id,
    employeeId: r.employee_id,
    date: r.date,
    shiftId: r.shift_id,
    kind: r.kind,
    priority: r.priority,
    reason: r.reason,
    status: r.status,
    decisionNote: r.decision_note,
    decidedAt: r.decided_at,
    fulfilledScheduleId: r.fulfilled_schedule_id,
    createdAt: r.created_at,
  };
}

export function leaveWishDto(r: any) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    startDate: r.start_date,
    endDate: r.end_date,
    leaveDays: r.leave_days,
    priority: r.priority,
    reason: r.reason,
    status: r.status,
    decisionNote: r.decision_note,
    decidedAt: r.decided_at,
    fulfilledTimeOffId: r.fulfilled_time_off_id,
    createdAt: r.created_at,
  };
}

const TRANSITIONS: Record<string, string[]> = { pending: ['approved', 'rejected', 'cancelled'], approved: ['cancelled'], rejected: [], cancelled: [] };

function wishDeadline(ctxIsManager: boolean, minLeadDays: number | null, today: string, date: string) {
  if (ctxIsManager || minLeadDays === null || minLeadDays === undefined) return;
  if (date < addDays(today, minLeadDays)) throw new AppError('WISH_DEADLINE_PASSED', { details: [{ field: 'date', issue: `wishes need at least ${minLeadDays} days lead time` }] });
}

// ---------------- shift wishes ----------------
export async function createShiftWish(
  db: Db,
  ctx: AuthContext,
  param: string | number,
  input: { hotelId?: number; date: string; shiftId?: number | null; kind: 'prefer' | 'avoid'; priority?: number; reason?: string | null },
) {
  const access = await getEmployeeAccess(db, ctx, param);
  const managerActs = ctx.role !== 'staff' && access.hotelIds.some((h) => ctx.hotelIds.includes(h));
  if (!access.isSelf && !managerActs) throw new AppError('FORBIDDEN');
  if (!input.shiftId && input.kind !== 'avoid') {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'shiftId', issue: 'only an avoid wish may omit the shift (day off)' }] });
  }
  let hotelId: number;
  if (input.shiftId) {
    const s = await maybeOne(db, 'SELECT hotel_id FROM shifts WHERE id = $1 AND deleted_at IS NULL', [input.shiftId]);
    if (!s || !access.hotelIds.includes(s.hotel_id)) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'shiftId' }] });
    hotelId = s.hotel_id;
  } else if (input.hotelId) {
    if (!access.hotelIds.includes(input.hotelId)) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'hotelId' }] });
    hotelId = input.hotelId;
  } else {
    hotelId = access.homeHotelId ?? access.hotelIds[0];
  }
  if (!access.isSelf && !ctx.hotelIds.includes(hotelId)) throw new AppError('FORBIDDEN');
  const hotel = await loadHotel(db, hotelId);
  const today = todayIn(hotel.timezone, now());
  if (input.date < today) throw new AppError('SCHEDULE_DATE_IN_PAST');
  wishDeadline(managerActs && !access.isSelf, hotel.settings.wishes.minLeadDays, today, input.date);
  const entry = await maybeOne(db, 'SELECT id FROM schedules WHERE employee_id = $1 AND date = $2 LIMIT 1', [access.employeeId, input.date]);
  if (entry) throw new AppError('EMPLOYEE_ALREADY_SCHEDULED', { details: [{ field: 'date', issue: 'the employee already has a roster entry that day' }] });
  const absence = await maybeOne(db, `SELECT 1 FROM time_offs WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2 AND end_date >= $2`, [access.employeeId, input.date]);
  if (absence) throw new AppError('EMPLOYEE_ON_TIME_OFF');
  let r;
  try {
    r = await maybeOne(
      db,
      `INSERT INTO employee_shift_wishes (hotel_id, employee_id, date, shift_id, kind, priority, reason) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [hotelId, access.employeeId, input.date, input.shiftId ?? null, input.kind, input.priority ?? 2, input.reason ?? null],
    );
  } catch (err) {
    throw mapDbError(err) ?? err;
  }
  if (access.isSelf) await notify(db, { userIds: await managerIdsOfHotel(db, hotelId), kind: 'wish_submitted', params: { employeeId: access.employeeId, date: input.date }, entityType: 'shift_wish', entityId: r.id });
  await audit(db, ctx, { action: 'shift_wish.create', entityType: 'shift_wish', entityId: r.id, hotelId, after: { date: r.date, shiftId: r.shift_id, kind: r.kind } });
  return shiftWishDto(r);
}

export async function listShiftWishes(db: Db, ctx: AuthContext, q: { hotelId?: number; from?: string; to?: string; status?: string; employeeId?: string }) {
  if (ctx.role === 'staff' || q.employeeId === 'me') {
    if (!ctx.employeeId) throw new AppError('RESOURCE_NOT_FOUND');
    const list = await rows(
      db,
      `SELECT * FROM employee_shift_wishes WHERE employee_id = $1 AND ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3) AND ($4::text IS NULL OR status = $4) ORDER BY date, id`,
      [ctx.employeeId, q.from ?? null, q.to ?? null, q.status ?? null],
    );
    return { data: list.map(shiftWishDto) };
  }
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const list = await rows(
    db,
    `SELECT * FROM employee_shift_wishes WHERE hotel_id = $1 AND ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3)
        AND ($4::text IS NULL OR status = $4) AND ($5::bigint IS NULL OR employee_id = $5) ORDER BY date, id`,
    [hotelId, q.from ?? null, q.to ?? null, q.status ?? null, q.employeeId ? Number(q.employeeId) : null],
  );
  return { data: list.map(shiftWishDto) };
}

export async function decideShiftWish(db: Db, ctx: AuthContext, id: number, input: { status: 'approved' | 'rejected' | 'cancelled'; decisionNote?: string | null }) {
  const w = await maybeOne(db, 'SELECT * FROM employee_shift_wishes WHERE id = $1', [id]);
  if (!w) throw new AppError('RESOURCE_NOT_FOUND');
  const own = ctx.employeeId === w.employee_id;
  const managed = ctx.role !== 'staff' && ctx.hotelIds.includes(w.hotel_id);
  if (!own && !managed) throw new AppError('RESOURCE_NOT_FOUND');
  if (!managed && input.status !== 'cancelled') throw new AppError('FORBIDDEN', { details: [{ issue: 'only managers decide wishes' }] });
  if (!managed && w.status !== 'pending') throw new AppError('INVALID_STATUS_TRANSITION');
  if (!TRANSITIONS[w.status].includes(input.status)) throw new AppError('INVALID_STATUS_TRANSITION');
  const r = await maybeOne(
    db,
    `UPDATE employee_shift_wishes SET status = $2, decision_note = $3, decided_by_id = $4, decided_at = $5 WHERE id = $1 RETURNING *`,
    [id, input.status, input.decisionNote ?? null, managed ? ctx.userId : null, managed ? now() : null],
  );
  if (managed && !own && input.status !== 'cancelled') {
    await notify(db, { userIds: await userIdsOfEmployee(db, w.employee_id), kind: 'wish_decided', params: { status: input.status, date: w.date }, entityType: 'shift_wish', entityId: id });
  }
  await audit(db, ctx, { action: `shift_wish.${input.status}`, entityType: 'shift_wish', entityId: id, hotelId: w.hotel_id, before: { status: w.status }, after: { status: r.status } });
  return shiftWishDto(r);
}

// ---------------- leave wishes ----------------
export async function createLeaveWish(
  db: Db,
  ctx: AuthContext,
  param: string | number,
  input: { startDate: string; endDate: string; leaveDays?: number; priority?: number; reason?: string | null },
) {
  const access = await getEmployeeAccess(db, ctx, param);
  const managerActs = access.isHomeManager && ctx.role !== 'staff';
  if (!access.isSelf && !managerActs) throw new AppError('FORBIDDEN');
  if (input.endDate < input.startDate) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'endDate', issue: 'must not be before startDate' }] });
  const home = await homeHotelOf(db, access.employeeId);
  const today = todayIn(home?.timezone ?? 'Europe/Berlin', now());
  if (input.startDate <= today) throw new AppError('SCHEDULE_DATE_IN_PAST', { details: [{ field: 'startDate', issue: 'leave wishes are for future dates' }] });
  wishDeadline(managerActs && !access.isSelf, home?.settings.wishes.minLeadDays ?? null, today, input.startDate);
  let leaveDays = input.leaveDays;
  if (leaveDays === undefined) {
    const region = home?.holidayRegion ?? 'DE-HE';
    leaveDays = countTimeOffDays({ startDate: input.startDate, endDate: input.endDate, workWeekdays: access.employee.work_weekdays, holidayName: (d) => (access.employee.public_holidays_off ? holidayName(region, d) : null) }).total;
    if (leaveDays === 0) throw new AppError('NO_WORKING_DAYS_IN_RANGE');
  }
  let r;
  try {
    r = await maybeOne(
      db,
      `INSERT INTO employee_leave_wishes (employee_id, start_date, end_date, leave_days, priority, reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [access.employeeId, input.startDate, input.endDate, leaveDays, input.priority ?? 2, input.reason ?? null],
    );
  } catch (err) {
    throw mapDbError(err) ?? err;
  }
  if (access.isSelf && home) await notify(db, { userIds: await managerIdsOfHotel(db, home.id), kind: 'wish_submitted', params: { employeeId: access.employeeId, startDate: r.start_date, endDate: r.end_date }, entityType: 'leave_wish', entityId: r.id });
  await audit(db, ctx, { action: 'leave_wish.create', entityType: 'leave_wish', entityId: r.id, hotelId: home?.id ?? null, after: { startDate: r.start_date, endDate: r.end_date, leaveDays: r.leave_days } });
  return leaveWishDto(r);
}

export async function listLeaveWishes(db: Db, ctx: AuthContext, q: { hotelId?: number; from?: string; to?: string; status?: string; employeeId?: string }) {
  if (ctx.role === 'staff' || q.employeeId === 'me') {
    if (!ctx.employeeId) throw new AppError('RESOURCE_NOT_FOUND');
    const list = await rows(
      db,
      `SELECT * FROM employee_leave_wishes WHERE employee_id = $1 AND ($2::date IS NULL OR end_date >= $2) AND ($3::date IS NULL OR start_date <= $3) AND ($4::text IS NULL OR status = $4) ORDER BY start_date, id`,
      [ctx.employeeId, q.from ?? null, q.to ?? null, q.status ?? null],
    );
    return { data: list.map(leaveWishDto) };
  }
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const list = await rows(
    db,
    `SELECT w.* FROM employee_leave_wishes w JOIN employee_hotels eh ON eh.employee_id = w.employee_id AND eh.is_home AND eh.hotel_id = $1
      WHERE ($2::date IS NULL OR w.end_date >= $2) AND ($3::date IS NULL OR w.start_date <= $3) AND ($4::text IS NULL OR w.status = $4)
        AND ($5::bigint IS NULL OR w.employee_id = $5) ORDER BY w.start_date, w.id`,
    [hotelId, q.from ?? null, q.to ?? null, q.status ?? null, q.employeeId ? Number(q.employeeId) : null],
  );
  return { data: list.map(leaveWishDto) };
}

export async function decideLeaveWish(db: Db, ctx: AuthContext, id: number, input: { status: 'approved' | 'rejected' | 'cancelled'; decisionNote?: string | null }) {
  const w = await maybeOne(db, 'SELECT * FROM employee_leave_wishes WHERE id = $1', [id]);
  if (!w) throw new AppError('RESOURCE_NOT_FOUND');
  const access = await getEmployeeAccess(db, ctx, w.employee_id);
  const managed = access.isHomeManager && ctx.role !== 'staff';
  if (!access.isSelf && !managed) throw new AppError('RESOURCE_NOT_FOUND');
  if (!managed && input.status !== 'cancelled') throw new AppError('FORBIDDEN', { details: [{ issue: 'only managers of the home hotel decide leave wishes' }] });
  if (!managed && w.status !== 'pending') throw new AppError('INVALID_STATUS_TRANSITION');
  if (!TRANSITIONS[w.status].includes(input.status)) throw new AppError('INVALID_STATUS_TRANSITION');
  let r;
  try {
    r = await maybeOne(
      db,
      `UPDATE employee_leave_wishes SET status = $2, decision_note = $3, decided_by_id = $4, decided_at = $5 WHERE id = $1 RETURNING *`,
      [id, input.status, input.decisionNote ?? null, managed ? ctx.userId : null, managed ? now() : null],
    );
  } catch (err) {
    throw mapDbError(err) ?? err;
  }
  if (managed && !access.isSelf && input.status !== 'cancelled') {
    await notify(db, { userIds: await userIdsOfEmployee(db, w.employee_id), kind: 'wish_decided', params: { status: input.status, startDate: w.start_date, endDate: w.end_date }, entityType: 'leave_wish', entityId: id });
  }
  await audit(db, ctx, { action: `leave_wish.${input.status}`, entityType: 'leave_wish', entityId: id, hotelId: access.homeHotelId, before: { status: w.status }, after: { status: r.status } });
  return leaveWishDto(r);
}

// ---------------- planning dashboard (W7) ----------------
export async function planningDashboard(db: Db, ctx: AuthContext, hotelId: number, q: { from?: string; to?: string }) {
  if (!ctx.hotelIds.includes(hotelId)) throw new AppError('RESOURCE_NOT_FOUND');
  const hotel = await loadHotel(db, hotelId);
  const today = todayIn(hotel.timezone, now());
  const from = q.from ?? today;
  const to = q.to ?? addDays(from, 41);
  const nameFmt = hotel.settings.portal.nameFormat;
  const sw = await rows(
    db,
    `SELECT w.*, e.first_name, e.last_name, sh.name AS shift_name, sh.start_time, sh.end_time, d.id AS department_id, d.name AS department_name
       FROM employee_shift_wishes w JOIN employees e ON e.id = w.employee_id
       LEFT JOIN shifts sh ON sh.id = w.shift_id LEFT JOIN departments d ON d.id = sh.department_id
      WHERE w.hotel_id = $1 AND w.date BETWEEN $2 AND $3 ORDER BY w.date, w.priority, w.id`,
    [hotelId, from, to],
  );
  const lw = await rows(
    db,
    `SELECT w.*, e.first_name, e.last_name FROM employee_leave_wishes w JOIN employees e ON e.id = w.employee_id
       JOIN employee_hotels eh ON eh.employee_id = w.employee_id AND eh.is_home AND eh.hotel_id = $1
      WHERE w.start_date <= $3 AND w.end_date >= $2 ORDER BY w.start_date, w.priority, w.id`,
    [hotelId, from, to],
  );
  const reqs = await rows(
    db,
    `SELECT r.shift_id, r.weekday, r.min_staff, s.name FROM shift_staffing_requirements r JOIN shifts s ON s.id = r.shift_id
      WHERE r.hotel_id = $1 AND s.deleted_at IS NULL`,
    [hotelId],
  );
  const leaveWishes = [];
  for (const w of lw) {
    let coverageRisk: { level: string; understaffedDates: string[] } | null = null;
    if (reqs.length > 0) {
      const understaffed: string[] = [];
      for (const date of eachDate(w.start_date, w.end_date)) {
        const wd = isoWeekday(date);
        for (const r of reqs.filter((x) => x.weekday === wd && x.min_staff > 0)) {
          const n = (
            await maybeOne(
              db,
              `SELECT count(*)::int AS n FROM schedules s
                WHERE s.hotel_id = $1 AND s.shift_id = $2 AND s.date = $3 AND s.employee_id <> $4
                  AND NOT EXISTS (SELECT 1 FROM time_offs t WHERE t.employee_id = s.employee_id AND t.status = 'approved' AND t.start_date <= $3 AND t.end_date >= $3)`,
              [hotelId, r.shift_id, date, w.employee_id],
            )
          ).n;
          if (n < r.min_staff && !understaffed.includes(date)) understaffed.push(date);
        }
      }
      coverageRisk = { level: understaffed.length === 0 ? 'none' : understaffed.length > 2 ? 'high' : 'low', understaffedDates: understaffed };
    }
    leaveWishes.push({
      id: w.id,
      employee: { id: w.employee_id, displayName: displayName(w.first_name, w.last_name, nameFmt) },
      startDate: w.start_date,
      endDate: w.end_date,
      leaveDays: w.leave_days,
      priority: w.priority,
      reason: w.reason,
      status: w.status,
      coverageRisk,
    });
  }
  return {
    period: { from, to },
    shiftWishes: sw.map((w) => ({
      id: w.id,
      employee: { id: w.employee_id, displayName: displayName(w.first_name, w.last_name, nameFmt) },
      department: w.department_id ? { id: w.department_id, name: w.department_name } : null,
      date: w.date,
      shift: w.shift_id ? { id: w.shift_id, name: w.shift_name, startTime: w.start_time, endTime: w.end_time } : null,
      kind: w.kind,
      priority: w.priority,
      reason: w.reason,
      status: w.status,
    })),
    leaveWishes,
    summary: {
      pendingShiftWishes: sw.filter((w) => w.status === 'pending').length,
      pendingLeaveWishes: lw.filter((w) => w.status === 'pending').length,
    },
  };
}
