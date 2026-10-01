import type pg from 'pg';
import { rows } from '../../db/pool';
import { lockEmployees, withTransaction } from '../../db/tx';
import { AppError } from '../../errors/AppError';
import { toAppError } from '../../middleware/errorHandler';
import { ERROR_CATALOG } from '../../errors/catalog';
import type { AuthContext } from '../../types/context';
import { addDays, daysBetween, todayIn } from '../../domain/dates';
import { now } from '../../clock';
import { audit } from '../audit';
import { loadHotel, resolveHotelId } from '../access';
import { createInTx } from './schedules';
import { EntryInput } from './evaluate';

export interface BulkItem {
  entryType: 'shift' | 'off';
  employeeId: number;
  shiftId?: number | null;
  date: string;
  offLabel?: string | null;
  overrideReason?: string | null;
}

interface ItemResult {
  index: number;
  status: 'created' | 'error';
  id?: number;
  warnings?: unknown[];
  error?: { code: string; message: string; details?: unknown };
}

async function runItems(db: pg.PoolClient, ctx: AuthContext, hotelId: number, items: (BulkItem & { _meta?: Record<string, unknown> })[]) {
  const results: ItemResult[] = [];
  let sp = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const name = `bulk_${sp++}`;
    await db.query(`SAVEPOINT ${name}`);
    try {
      const input: EntryInput = { hotelId, entryType: item.entryType, employeeId: item.employeeId, shiftId: item.shiftId ?? null, date: item.date, offLabel: item.offLabel ?? null, overrideReason: item.overrideReason ?? null };
      const { id, ev } = await createInTx(db, ctx, input, item._meta ?? { bulk: true });
      await db.query(`RELEASE SAVEPOINT ${name}`);
      results.push({ index: i, status: 'created', id, warnings: ev.warnings });
    } catch (err) {
      await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
      const e = toAppError(err);
      if (e.code === 'INTERNAL_ERROR') throw err;
      results.push({ index: i, status: 'error', error: { code: e.code, message: ERROR_CATALOG[e.code][ctx.lang], ...(e.details ? { details: e.details } : {}) } });
    }
  }
  return results;
}

/**
 * C8: partial → each item stands alone; atomic → any error rolls everything back (409 BULK_FAILED with the same results).
 */
export async function bulkCreate(ctx: AuthContext, body: { hotelId?: number; mode: 'partial' | 'atomic'; items: BulkItem[] }) {
  const hotelId = resolveHotelId(ctx, body.hotelId);
  let failedResults: { results: ItemResult[]; summary: { created: number; failed: number } } | null = null;
  try {
    return await withTransaction(async (db) => {
      await lockEmployees(db, body.items.map((i) => i.employeeId));
      const results = await runItems(db, ctx, hotelId, body.items);
      const summary = { created: results.filter((r) => r.status === 'created').length, failed: results.filter((r) => r.status === 'error').length };
      if (body.mode === 'atomic' && summary.failed > 0) {
        failedResults = {
          results: results.map((r) => (r.status === 'created' ? { index: r.index, status: 'created' as const, warnings: r.warnings } : r)),
          summary: { created: 0, failed: summary.failed },
        };
        throw new AppError('BULK_FAILED');
      }
      return { results, summary };
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'BULK_FAILED' && failedResults) {
      throw new AppError('BULK_FAILED', { body: failedResults as any });
    }
    throw err;
  }
}

/** C9: shifts every entry by targetFrom − sourceFrom days and creates drafts. */
export async function copyWeek(
  ctx: AuthContext,
  body: { hotelId?: number; sourceFrom: string; sourceTo: string; targetFrom: string; departmentId?: number; employeeIds?: number[]; overwrite?: boolean },
) {
  const hotelId = resolveHotelId(ctx, body.hotelId);
  if (body.sourceTo < body.sourceFrom) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'sourceTo', issue: 'must not be before sourceFrom' }] });
  if (daysBetween(body.sourceFrom, body.sourceTo) > 61) throw new AppError('RANGE_TOO_LARGE');
  return withTransaction(async (db) => {
    const hotel = await loadHotel(db, hotelId);
    const today = todayIn(hotel.timezone, now());
    if (body.targetFrom < today) throw new AppError('SCHEDULE_DATE_IN_PAST', { details: [{ field: 'targetFrom', issue: 'target dates must be in the future' }] });
    const offset = daysBetween(body.sourceFrom, body.targetFrom);
    const source = await rows(
      db,
      `SELECT s.*, sh.department_id FROM schedules s LEFT JOIN shifts sh ON sh.id = s.shift_id
        WHERE s.hotel_id = $1 AND s.date BETWEEN $2 AND $3
          AND ($4::bigint IS NULL OR sh.department_id = $4 OR (s.entry_type = 'off' AND EXISTS (
                SELECT 1 FROM employee_departments ed WHERE ed.employee_id = s.employee_id AND ed.department_id = $4)))
          AND ($5::bigint[] IS NULL OR s.employee_id = ANY($5::bigint[]))
        ORDER BY s.date, s.employee_id, s.id`,
      [hotelId, body.sourceFrom, body.sourceTo, body.departmentId ?? null, body.employeeIds ?? null],
    );
    const empIds = [...new Set(source.map((s) => s.employee_id))];
    await lockEmployees(db, empIds);
    const targetTo = addDays(body.sourceTo, offset);
    const targetFrom = body.targetFrom;
    const emps = new Map((await rows(db, 'SELECT * FROM employees WHERE id = ANY($1::bigint[])', [empIds])).map((e) => [e.id, e]));
    const existing = await rows(db, 'SELECT * FROM schedules WHERE employee_id = ANY($1::bigint[]) AND date BETWEEN $2 AND $3', [empIds, targetFrom, targetTo]);
    const absences = await rows(
      db,
      `SELECT employee_id, start_date, end_date FROM time_offs WHERE employee_id = ANY($1::bigint[]) AND status = 'approved' AND start_date <= $3 AND end_date >= $2`,
      [empIds, targetFrom, targetTo],
    );
    const assignments = await rows(db, 'SELECT * FROM employee_hotels WHERE employee_id = ANY($1::bigint[]) AND hotel_id = $2', [empIds, hotelId]);
    const skipped: { employeeId: number; date: string; reason: string }[] = [];
    const items: (BulkItem & { _meta?: Record<string, unknown> })[] = [];
    const cleared = new Set<string>();
    for (const s of source) {
      const date = addDays(s.date, offset);
      if (date < today) {
        skipped.push({ employeeId: s.employee_id, date, reason: 'date_in_past' });
        continue;
      }
      const e = emps.get(s.employee_id);
      if (!e || e.deleted_at || e.status === 'terminated' || (e.terminated_on && e.terminated_on < date)) {
        skipped.push({ employeeId: s.employee_id, date, reason: 'employee_inactive' });
        continue;
      }
      const a = assignments.find((x) => x.employee_id === s.employee_id);
      if (!a || (a.unassigned_on && a.unassigned_on < date)) {
        skipped.push({ employeeId: s.employee_id, date, reason: 'not_assigned_to_hotel' });
        continue;
      }
      if (absences.some((x) => x.employee_id === s.employee_id && x.start_date <= date && x.end_date >= date)) {
        skipped.push({ employeeId: s.employee_id, date, reason: 'on_time_off' });
        continue;
      }
      const key = `${s.employee_id}|${date}`;
      const there = existing.filter((x) => x.employee_id === s.employee_id && x.date === date);
      if (there.length > 0) {
        const replaceable = body.overwrite && there.every((x) => x.hotel_id === hotelId && x.status === 'draft');
        if (!replaceable) {
          skipped.push({ employeeId: s.employee_id, date, reason: 'already_scheduled' });
          continue;
        }
        if (!cleared.has(key)) {
          await db.query(`DELETE FROM schedules WHERE employee_id = $1 AND date = $2 AND hotel_id = $3 AND status = 'draft'`, [s.employee_id, date, hotelId]);
          cleared.add(key);
        }
      }
      items.push({
        entryType: s.entry_type,
        employeeId: s.employee_id,
        shiftId: s.shift_id,
        date,
        offLabel: s.off_label,
        overrideReason: s.override_reason,
        _meta: { copiedFrom: s.id },
      });
    }
    const results = await runItems(db, ctx, hotelId, items);
    const summary = { created: results.filter((r) => r.status === 'created').length, failed: results.filter((r) => r.status === 'error').length };
    await audit(db, ctx, { action: 'schedule.copy', entityType: 'schedule', hotelId, meta: { sourceFrom: body.sourceFrom, sourceTo: body.sourceTo, targetFrom, ...summary, skipped: skipped.length } });
    return { results, summary, skipped };
  });
}
