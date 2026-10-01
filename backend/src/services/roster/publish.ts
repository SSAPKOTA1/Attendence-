import { rows } from '../../db/pool';
import { lockEmployees, withTransaction } from '../../db/tx';
import { AppError } from '../../errors/AppError';
import type { AuthContext } from '../../types/context';
import { todayIn } from '../../domain/dates';
import { now } from '../../clock';
import { audit } from '../audit';
import { loadHotel, resolveHotelId } from '../access';
import { notify, userIdsOfEmployee } from '../notifications';
import { loadEntryById } from './entries';
import { evaluateEntry } from './evaluate';

const DEPT_FILTER = `AND ($4::bigint IS NULL OR sh.department_id = $4 OR (s.entry_type = 'off' AND EXISTS (
      SELECT 1 FROM employee_departments ed WHERE ed.employee_id = s.employee_id AND ed.department_id = $4)))`;

/** R12: all-or-nothing publish after re-validating every draft against the hard blocks. */
export async function publish(ctx: AuthContext, body: { hotelId?: number; from: string; to: string; departmentId?: number }) {
  const hotelId = resolveHotelId(ctx, body.hotelId);
  if (body.to < body.from) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'to', issue: 'must not be before from' }] });
  return withTransaction(async (db) => {
    const drafts = await rows(
      db,
      `SELECT s.id, s.employee_id FROM schedules s LEFT JOIN shifts sh ON sh.id = s.shift_id
        WHERE s.hotel_id = $1 AND s.date BETWEEN $2 AND $3 AND s.status = 'draft' ${DEPT_FILTER} ORDER BY s.date, s.id`,
      [hotelId, body.from, body.to, body.departmentId ?? null],
    );
    await lockEmployees(db, drafts.map((d) => d.employee_id));
    const conflicts: { scheduleId: number; code: string; details?: unknown }[] = [];
    for (const d of drafts) {
      const e = await loadEntryById(db, d.id);
      if (!e) continue;
      try {
        await evaluateEntry(
          db,
          ctx,
          { hotelId, entryType: e.entryType, employeeId: e.employeeId, shiftId: e.shiftId, date: e.date, offLabel: e.offLabel, overrideReason: e.overrideReason },
          { mode: 'publish', existing: e, skipPast: true },
        );
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        conflicts.push({ scheduleId: d.id, code: err.code, ...(err.details ? { details: err.details } : {}) });
      }
    }
    if (conflicts.length > 0) throw new AppError('PUBLISH_CONFLICTS', { details: conflicts });
    const t = now();
    const ids = drafts.map((d) => d.id);
    if (ids.length > 0) {
      await db.query(`UPDATE schedules SET status = 'published', published_at = $2, published_by_id = $3 WHERE id = ANY($1::bigint[])`, [ids, t, ctx.userId]);
    }
    const employees = [...new Set(drafts.map((d) => d.employee_id))];
    for (const emp of employees) {
      await notify(db, {
        userIds: await userIdsOfEmployee(db, emp),
        kind: 'roster_published',
        params: { hotelId, from: body.from, to: body.to },
        entityType: 'hotel',
        entityId: hotelId,
      });
    }
    await audit(db, ctx, { action: 'schedule.publish', entityType: 'schedule', hotelId, meta: { from: body.from, to: body.to, departmentId: body.departmentId ?? null, published: ids.length } });
    return { published: ids.length, from: body.from, to: body.to };
  });
}

export async function unpublish(ctx: AuthContext, body: { hotelId?: number; from: string; to: string; departmentId?: number }) {
  const hotelId = resolveHotelId(ctx, body.hotelId);
  return withTransaction(async (db) => {
    const hotel = await loadHotel(db, hotelId);
    const today = todayIn(hotel.timezone, now());
    if (body.from < today) throw new AppError('SCHEDULE_DATE_IN_PAST', { details: [{ field: 'from', issue: 'only future dates can be unpublished' }] });
    const res = await db.query(
      `UPDATE schedules s SET status = 'draft', published_at = NULL, published_by_id = NULL
         FROM (SELECT s.id FROM schedules s LEFT JOIN shifts sh ON sh.id = s.shift_id
                WHERE s.hotel_id = $1 AND s.date BETWEEN $2 AND $3 AND s.status = 'published' ${DEPT_FILTER}) x
        WHERE s.id = x.id`,
      [hotelId, body.from, body.to, body.departmentId ?? null],
    );
    await audit(db, ctx, { action: 'schedule.unpublish', entityType: 'schedule', hotelId, meta: { from: body.from, to: body.to, unpublished: res.rowCount } });
    return { unpublished: res.rowCount ?? 0, from: body.from, to: body.to };
  });
}
