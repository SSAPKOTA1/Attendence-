import { Db, maybeOne, rows } from '../db/pool';
import { withTransaction } from '../db/tx';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { displayName } from '../domain/names';
import { now } from '../clock';
import { audit } from './audit';
import { homeHotelOf } from './access';
import { managerIdsOfHotel, notify, userIdsOfEmployee } from './notifications';

const DAILY_LIMIT = 20;
type Related = { type: 'schedule' | 'time_entry' | 'time_off' | 'shift_wish' | 'leave_wish' | 'correction'; id: number };

/** R16 routing: the related entry's hotel, else the employee's home hotel. Related entries must be the employee's own. */
async function routeHotel(db: Db, employeeId: number, related?: Related | null): Promise<number> {
  const home = await homeHotelOf(db, employeeId);
  if (!related) {
    if (!home) throw new AppError('VALIDATION_ERROR', { details: [{ issue: 'employee has no home hotel' }] });
    return home.id;
  }
  const table: Record<Related['type'], string> = {
    schedule: 'schedules',
    time_entry: 'time_entries',
    correction: 'time_entry_corrections',
    shift_wish: 'employee_shift_wishes',
    time_off: 'time_offs',
    leave_wish: 'employee_leave_wishes',
  };
  const hasHotel = ['schedule', 'time_entry', 'correction', 'shift_wish'].includes(related.type);
  const r = await maybeOne(db, `SELECT employee_id${hasHotel ? ', hotel_id' : ''} FROM ${table[related.type]} WHERE id = $1`, [related.id]);
  if (!r || r.employee_id !== employeeId) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'related.id' }] });
  if (hasHotel) return r.hotel_id;
  if (!home) throw new AppError('VALIDATION_ERROR', { details: [{ issue: 'employee has no home hotel' }] });
  return home.id;
}

async function loadVisible(db: Db, ctx: AuthContext, id: number) {
  const i = await maybeOne(db, 'SELECT * FROM inquiries WHERE id = $1', [id]);
  if (!i) throw new AppError('RESOURCE_NOT_FOUND');
  const own = ctx.employeeId === i.employee_id;
  const routed = ctx.role !== 'staff' && ctx.hotelIds.includes(i.hotel_id);
  if (!own && !routed) throw new AppError('RESOURCE_NOT_FOUND');
  return { i, own, routed };
}

function summaryDto(i: any) {
  return {
    id: i.id,
    employeeId: i.employee_id,
    hotelId: i.hotel_id,
    subject: i.subject,
    category: i.category,
    status: i.status,
    related: i.related_type ? { type: i.related_type, id: i.related_id } : null,
    assignedToId: i.assigned_to_id,
    lastMessageAt: i.last_message_at,
    createdAt: i.created_at,
  };
}

export async function createInquiry(ctx: AuthContext, input: { subject: string; category: string; body: string; related?: Related | null }) {
  if (!ctx.employeeId) throw new AppError('FORBIDDEN', { details: [{ issue: 'only employees open inquiries' }] });
  const employeeId = ctx.employeeId;
  return withTransaction(async (db) => {
    await db.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [employeeId]);
    const since = new Date(now().getTime() - 86_400_000);
    const count = (await maybeOne(db, 'SELECT count(*)::int n FROM inquiries WHERE employee_id = $1 AND created_at > $2', [employeeId, since])).n;
    if (count >= DAILY_LIMIT) throw new AppError('RATE_LIMITED', { details: [{ issue: `at most ${DAILY_LIMIT} new inquiries per day` }] });
    const hotelId = await routeHotel(db, employeeId, input.related);
    const t = now();
    const i = await maybeOne(
      db,
      `INSERT INTO inquiries (employee_id, hotel_id, subject, category, related_type, related_id, last_message_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
      [employeeId, hotelId, input.subject, input.category, input.related?.type ?? null, input.related?.id ?? null, t],
    );
    await db.query('INSERT INTO inquiry_messages (inquiry_id, author_user_id, body, created_at) VALUES ($1,$2,$3,$4)', [i.id, ctx.userId, input.body, t]);
    await notify(db, { userIds: await managerIdsOfHotel(db, hotelId), kind: 'inquiry_new', params: { inquiryId: i.id, category: i.category }, entityType: 'inquiry', entityId: i.id });
    await audit(db, ctx, { action: 'inquiry.create', entityType: 'inquiry', entityId: i.id, hotelId, meta: { category: i.category } });
    return { id: i.id, status: i.status, hotelId: i.hotel_id };
  });
}

export async function listInquiries(db: Db, ctx: AuthContext, q: { status?: string; hotelId?: number; page: number; limit: number }) {
  let where: string;
  const params: unknown[] = [q.status ?? null];
  if (ctx.role === 'staff') {
    params.push(ctx.employeeId ?? 0);
    where = 'employee_id = $2';
  } else {
    const hotels = q.hotelId ? ctx.hotelIds.filter((h) => h === q.hotelId) : ctx.hotelIds;
    params.push(hotels, ctx.employeeId ?? 0);
    where = '(hotel_id = ANY($2::bigint[]) OR employee_id = $3)';
  }
  const base = `FROM inquiries WHERE ${where} AND ($1::text IS NULL OR status = $1)`;
  const total = (await maybeOne(db, `SELECT count(*)::int n ${base}`, params)).n;
  const list = await rows(db, `SELECT * ${base} ORDER BY last_message_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, q.limit, (q.page - 1) * q.limit]);
  return { data: list.map(summaryDto), total };
}

export async function getInquiry(db: Db, ctx: AuthContext, id: number) {
  const { i } = await loadVisible(db, ctx, id);
  const emp = await maybeOne(db, 'SELECT first_name, last_name FROM employees WHERE id = $1', [i.employee_id]);
  const assigned = i.assigned_to_id ? await maybeOne(db, 'SELECT first_name, last_name, username FROM users WHERE id = $1', [i.assigned_to_id]) : null;
  const msgs = await rows(
    db,
    `SELECT m.*, u.first_name, u.last_name, u.username, u.role, u.employee_id FROM inquiry_messages m JOIN users u ON u.id = m.author_user_id
      WHERE m.inquiry_id = $1 ORDER BY m.created_at, m.id`,
    [id],
  );
  const userName = (u: any) => displayName(u.first_name ?? u.username ?? '', u.last_name ?? '');
  return {
    ...summaryDto(i),
    employee: { id: i.employee_id, displayName: displayName(emp.first_name, emp.last_name) },
    assignedTo: assigned ? { id: i.assigned_to_id, displayName: userName(assigned) } : null,
    messages: msgs.map((m) => ({
      id: m.id,
      author: { displayName: userName(m), role: m.employee_id === i.employee_id ? 'staff' : m.role },
      body: m.body,
      createdAt: m.created_at,
    })),
  };
}

export async function addMessage(ctx: AuthContext, id: number, body: string) {
  return withTransaction(async (db) => {
    const { i, own, routed } = await loadVisible(db, ctx, id);
    const t = now();
    await db.query('INSERT INTO inquiry_messages (inquiry_id, author_user_id, body, created_at) VALUES ($1,$2,$3,$4)', [id, ctx.userId, body, t]);
    const fromEmployee = own;
    const status = fromEmployee ? 'open' : 'answered';
    await db.query('UPDATE inquiries SET status = $2, closed_at = NULL, last_message_at = $3 WHERE id = $1', [id, status, t]);
    if (!fromEmployee && routed) {
      await notify(db, { userIds: await userIdsOfEmployee(db, i.employee_id), kind: 'inquiry_reply', params: { inquiryId: id }, entityType: 'inquiry', entityId: id });
    } else {
      const recipients = i.assigned_to_id ? [i.assigned_to_id] : await managerIdsOfHotel(db, i.hotel_id);
      await notify(db, { userIds: recipients, kind: 'inquiry_new', params: { inquiryId: id, reply: true }, entityType: 'inquiry', entityId: id });
    }
    await audit(db, ctx, { action: 'inquiry.message', entityType: 'inquiry', entityId: id, hotelId: i.hotel_id, meta: { status } });
    return getInquiry(db, ctx, id);
  });
}

export async function updateInquiry(db: Db, ctx: AuthContext, id: number, input: { status?: 'open' | 'closed'; assignedToId?: number | null }) {
  const { i, routed } = await loadVisible(db, ctx, id);
  if (input.assignedToId !== undefined) {
    if (!routed) throw new AppError('FORBIDDEN', { details: [{ field: 'assignedToId', issue: 'managers only' }] });
    if (input.assignedToId !== null) {
      const m = await maybeOne(
        db,
        `SELECT u.id FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL AND u.status = 'active' AND u.company_id = $3
            AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM user_hotel_access a WHERE a.user_id = u.id AND a.hotel_id = $2))`,
        [input.assignedToId, i.hotel_id, ctx.companyId],
      );
      if (!m) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'assignedToId', issue: 'must be a manager of the routed hotel' }] });
    }
    await db.query('UPDATE inquiries SET assigned_to_id = $2 WHERE id = $1', [id, input.assignedToId]);
  }
  if (input.status) {
    const t = now();
    if (input.status === 'closed') await db.query(`UPDATE inquiries SET status = 'closed', closed_at = $2 WHERE id = $1`, [id, t]);
    else await db.query(`UPDATE inquiries SET status = 'open', closed_at = NULL WHERE id = $1`, [id]);
  }
  await audit(db, ctx, { action: 'inquiry.update', entityType: 'inquiry', entityId: id, hotelId: i.hotel_id, after: { status: input.status, assignedToId: input.assignedToId } });
  return getInquiry(db, ctx, id);
}
