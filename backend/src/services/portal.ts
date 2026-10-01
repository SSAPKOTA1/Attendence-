import { Db, maybeOne, rows } from '../db/pool';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { addDays, monthEnd, monthOf, monthStart, todayIn, weekEnd, weekStart } from '../domain/dates';
import { toHours } from '../domain/hours';
import { now } from '../clock';
import { audit } from './audit';
import { getEmployeeAccess, homeHotelOf } from './access';
import { computeAllowance } from './allowance';
import { creditsFor } from './credits';
import { loadTargets } from './employees';
import { loadEmployeeEntries } from './roster/entries';
import { timeAccount, workedByMonth } from './timeAccount';
import { EMAIL_DEFAULTS, NOTIFICATION_KINDS, NotificationKind } from './notifications';
import { localDate } from '../domain/dates';
import { workedMinutes } from '../domain/anomalies';

function requireEmployee(ctx: AuthContext): number {
  if (!ctx.employeeId) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ issue: 'no employee linked to this login' }] });
  return ctx.employeeId;
}

async function workedBetween(db: Db, employeeId: number, from: string, to: string) {
  const list = await rows(
    db,
    `SELECT te.* FROM time_entries te JOIN hotels h ON h.id = te.hotel_id
      WHERE te.employee_id = $1 AND te.status = 'closed' AND (te.clock_in_at AT TIME ZONE h.timezone)::date BETWEEN $2 AND $3`,
    [employeeId, from, to],
  );
  return list.reduce((a, e) => a + (workedMinutes(new Date(e.clock_in_at), new Date(e.clock_out_at), e.break_minutes) ?? 0), 0);
}

/** PO1: numbers come from the same functions as the underlying endpoints (test 103). */
export async function dashboard(db: Db, ctx: AuthContext) {
  const employeeId = requireEmployee(ctx);
  const home = await homeHotelOf(db, employeeId);
  const t = now();
  const today = todayIn(home?.timezone ?? 'Europe/Berlin', t);
  const open = await maybeOne(db, `SELECT * FROM time_entries WHERE employee_id = $1 AND status IN ('open','needs_review') ORDER BY clock_in_at DESC LIMIT 1`, [employeeId]);
  let status: 'not_in' | 'in' | 'on_break' = 'not_in';
  if (open && open.status === 'open') {
    const brk = await maybeOne(db, 'SELECT 1 FROM time_entry_breaks WHERE time_entry_id = $1 AND break_end_at IS NULL', [open.id]);
    status = brk ? 'on_break' : 'in';
  }
  const ws = weekStart(today);
  const we = weekEnd(today);
  const ms = monthStart(today);
  const me = monthEnd(today);
  const from = ws < ms ? ws : ms;
  const to = we > me ? we : addDays(me, 31);
  const entries = await loadEmployeeEntries(db, employeeId, from, to, { publishedOnly: true });
  const shifts = entries.filter((e) => e.entryType === 'shift');
  const todayShifts = shifts.filter((e) => e.date === today);
  const nextShifts = shifts.filter((e) => e.date > today).slice(0, 5);
  const targets = await loadTargets(db, employeeId);
  const credits = await creditsFor(db, employeeId, from, me);
  const sumPlanned = (a: string, b: string) => shifts.filter((e) => e.date >= a && e.date <= b).reduce((s, e) => s + e.paidMinutes, 0);
  const sumCredit = (a: string, b: string) => credits.filter((c) => c.date >= a && c.date <= b).reduce((s, c) => s + c.creditMinutes, 0);
  const month = monthOf(today);
  const account = await timeAccount(db, employeeId, month, month);
  const monthWorked = (await workedByMonth(db, employeeId, ms, me)).get(month)?.worked ?? 0;
  const vacation = await computeAllowance(db, employeeId, Number(today.slice(0, 4)));
  const pendingTimeOffs = (await maybeOne(db, `SELECT count(*)::int n FROM time_offs WHERE employee_id = $1 AND status = 'pending'`, [employeeId])).n;
  const pendingWishes =
    (await maybeOne(db, `SELECT count(*)::int n FROM employee_shift_wishes WHERE employee_id = $1 AND status = 'pending'`, [employeeId])).n +
    (await maybeOne(db, `SELECT count(*)::int n FROM employee_leave_wishes WHERE employee_id = $1 AND status = 'pending'`, [employeeId])).n;
  const pendingCorrections = (await maybeOne(db, `SELECT count(*)::int n FROM time_entry_corrections WHERE employee_id = $1 AND status = 'pending'`, [employeeId])).n;
  const inquiriesOpen = (await maybeOne(db, `SELECT count(*)::int n FROM inquiries WHERE employee_id = $1 AND status = 'open'`, [employeeId])).n;
  const inquiriesAnswered = (await maybeOne(db, `SELECT count(*)::int n FROM inquiries WHERE employee_id = $1 AND status = 'answered'`, [employeeId])).n;
  const unread = (await maybeOne(db, 'SELECT count(*)::int n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [ctx.userId])).n;
  const published = await rows(
    db,
    `SELECT h.id, h.name, (SELECT max(s.date) FROM schedules s WHERE s.hotel_id = h.id AND s.status = 'published') AS until
       FROM employee_hotels eh JOIN hotels h ON h.id = eh.hotel_id WHERE eh.employee_id = $1 AND eh.unassigned_on IS NULL ORDER BY h.id`,
    [employeeId],
  );
  const shiftView = (e: any) => ({ date: e.date, hotelName: e.hotelName, shiftName: e.shiftName, name: e.shiftName, startTime: e.startTime, endTime: e.endTime });
  return {
    today: { date: today, status, shifts: todayShifts.map((e) => ({ hotelName: e.hotelName, name: e.shiftName, startTime: e.startTime, endTime: e.endTime })) },
    nextShifts: nextShifts.map(shiftView),
    week: {
      weekStart: ws,
      plannedHours: toHours(sumPlanned(ws, we)),
      workedHours: toHours(await workedBetween(db, employeeId, ws, we)),
      creditedHours: toHours(sumCredit(ws, we)),
      targetHours: targets.targetHoursPerWeek,
    },
    month: {
      month,
      plannedHours: toHours(sumPlanned(ms, me)),
      workedHours: toHours(monthWorked),
      creditedHours: toHours(sumCredit(ms, me)),
      targetHours: targets.targetHoursPerMonth,
    },
    timeAccount: { enabled: account.timeAccountEnabled, balanceHours: account.balanceHours },
    vacation: { year: vacation.year, remainingDays: vacation.remainingDays, pendingDays: vacation.pendingDays, usedDays: vacation.usedDays },
    pending: { timeOffs: pendingTimeOffs, wishes: pendingWishes, corrections: pendingCorrections, inquiriesAwaitingAnswer: inquiriesOpen },
    unread: { notifications: unread, inquiriesAnswered },
    planPublishedUntil: published.map((p) => ({ hotelId: p.id, hotelName: p.name, date: p.until })),
    serverTime: t.toISOString(),
    localDate: localDate(t, home?.timezone ?? 'Europe/Berlin'),
  };
}

export async function profile(db: Db, ctx: AuthContext) {
  const u = await maybeOne(db, 'SELECT * FROM users WHERE id = $1', [ctx.userId]);
  const base = { email: u.email, username: u.username, preferredLanguage: u.preferred_language, role: u.role };
  if (!ctx.employeeId) return { firstName: u.first_name, lastName: u.last_name, ...base };
  const access = await getEmployeeAccess(db, ctx, ctx.employeeId);
  const e = access.employee;
  const hotels = await rows(
    db,
    `SELECT h.id, h.name, eh.is_home FROM employee_hotels eh JOIN hotels h ON h.id = eh.hotel_id WHERE eh.employee_id = $1 AND eh.unassigned_on IS NULL ORDER BY eh.is_home DESC, h.id`,
    [e.id],
  );
  const depts = await rows(
    db,
    `SELECT d.id, d.name, d.hotel_id FROM employee_departments ed JOIN departments d ON d.id = ed.department_id WHERE ed.employee_id = $1 AND d.deleted_at IS NULL ORDER BY d.hotel_id, d.name`,
    [e.id],
  );
  const home = hotels.find((h) => h.is_home);
  return {
    employeeId: e.id,
    firstName: e.first_name,
    lastName: e.last_name,
    employeeNumber: e.employee_number,
    employmentType: e.employment_type,
    workWeekdays: e.work_weekdays,
    homeHotel: home ? { id: home.id, name: home.name } : null,
    hotels: hotels.map((h) => ({ id: h.id, name: h.name, isHome: h.is_home })),
    departments: depts.map((d) => ({ id: d.id, name: d.name, hotelId: d.hotel_id })),
    birthDate: e.birth_date,
    phone: e.phone,
    ...base,
  };
}

export async function updateProfile(db: Db, ctx: AuthContext, input: { phone?: string | null; preferredLanguage?: 'de' | 'en' }) {
  if (input.phone !== undefined) {
    if (!ctx.employeeId) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'phone', issue: 'no employee linked' }] });
    await db.query('UPDATE employees SET phone = $2 WHERE id = $1', [ctx.employeeId, input.phone]);
  }
  if (input.preferredLanguage) await db.query('UPDATE users SET preferred_language = $2 WHERE id = $1', [ctx.userId, input.preferredLanguage]);
  await audit(db, ctx, { action: 'profile.update', entityType: 'user', entityId: ctx.userId, after: { changed: Object.keys(input) } });
  return profile(db, ctx);
}

// ---------------- notifications ----------------
function notificationDto(n: any) {
  return { id: n.id, kind: n.kind, params: n.params, entityType: n.entity_type, entityId: n.entity_id, urgent: n.urgent, createdAt: n.created_at, readAt: n.read_at };
}

export async function listNotifications(db: Db, ctx: AuthContext, q: { unread?: boolean; page: number; limit: number }) {
  const where = `user_id = $1 AND ($2::boolean IS NOT TRUE OR read_at IS NULL)`;
  const total = (await maybeOne(db, `SELECT count(*)::int n FROM notifications WHERE ${where}`, [ctx.userId, q.unread ?? null])).n;
  const unread = (await maybeOne(db, 'SELECT count(*)::int n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [ctx.userId])).n;
  const list = await rows(db, `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`, [ctx.userId, q.unread ?? null, q.limit, (q.page - 1) * q.limit]);
  return { data: list.map(notificationDto), meta: { page: q.page, limit: q.limit, total, unread } };
}

export async function markNotification(db: Db, ctx: AuthContext, id: number, read: boolean) {
  const r = await maybeOne(db, `UPDATE notifications SET read_at = CASE WHEN $3 THEN COALESCE(read_at, $4) ELSE NULL END WHERE id = $1 AND user_id = $2 RETURNING *`, [id, ctx.userId, read, now()]);
  if (!r) throw new AppError('RESOURCE_NOT_FOUND');
  return notificationDto(r);
}

export async function readAll(db: Db, ctx: AuthContext) {
  const res = await db.query('UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL', [ctx.userId, now()]);
  return { updated: res.rowCount ?? 0 };
}

export async function getPreferences(db: Db, ctx: AuthContext) {
  const prefs = await rows(db, 'SELECT kind, email FROM notification_preferences WHERE user_id = $1', [ctx.userId]);
  const out: Record<string, { email: boolean }> = {};
  for (const k of NOTIFICATION_KINDS) {
    const p = prefs.find((x) => x.kind === k);
    out[k] = { email: p ? p.email : EMAIL_DEFAULTS[k] };
  }
  return out;
}

export async function putPreferences(db: Db, ctx: AuthContext, input: Record<string, { email: boolean }>) {
  for (const [kind, v] of Object.entries(input)) {
    if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind)) throw new AppError('VALIDATION_ERROR', { details: [{ field: kind, issue: 'unknown notification kind' }] });
    await db.query(
      `INSERT INTO notification_preferences (user_id, kind, email) VALUES ($1,$2,$3) ON CONFLICT (user_id, kind) DO UPDATE SET email = EXCLUDED.email`,
      [ctx.userId, kind as NotificationKind, v.email],
    );
  }
  return getPreferences(db, ctx);
}
