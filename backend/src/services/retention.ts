import { Db, rows } from '../db/pool';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { todayIn } from '../domain/dates';
import { DateTime } from 'luxon';
import { now } from '../clock';
import { audit } from './audit';
import { getEmployeeAccess, homeHotelOf } from './access';
import { deactivateTerminated } from './employees';
import { revokeAllSessions } from './tokens';
import { loadHotel } from './access';

/**
 * E11 (R14): replaces personal data, keeps roster/absence/time records and the audit trail.
 * Before the retention period only with force + reason (e.g. a GDPR erasure request), audited.
 */
export async function anonymizeEmployee(db: Db, ctx: AuthContext, param: string | number, input: { force?: boolean; reason?: string }) {
  const access = await getEmployeeAccess(db, ctx, param);
  const e = access.employee;
  if (e.anonymized_at) throw new AppError('INVALID_STATUS_TRANSITION', { details: [{ issue: 'already anonymised' }] });
  if (e.status !== 'terminated' || !e.terminated_on) {
    throw new AppError('INVALID_STATUS_TRANSITION', { details: [{ field: 'status', issue: 'only terminated employees can be anonymised' }] });
  }
  const home = await homeHotelOf(db, e.id);
  const years = home?.settings.retention.timeRecordsYears ?? 3;
  const today = todayIn(home?.timezone ?? 'Europe/Berlin', now());
  const elapsedOn = DateTime.fromISO(e.terminated_on, { zone: 'utc' }).plus({ years }).toISODate()!;
  const elapsed = today >= elapsedOn;
  if (!elapsed && !(input.force && input.reason)) {
    throw new AppError('RETENTION_NOT_ELAPSED', { details: [{ field: 'terminatedOn', issue: `retention ends on ${elapsedOn}`, retentionEndsOn: elapsedOn }] });
  }
  await deactivateTerminated(db, e.id);
  // inquiry texts are free text and may contain personal data: erased with the person (messages cascade)
  await db.query('DELETE FROM inquiries WHERE employee_id = $1', [e.id]);
  await db.query(
    `UPDATE employees SET first_name = 'Former employee', last_name = $2, email = NULL, phone = NULL, hourly_rate = NULL,
            birth_date = NULL, employee_number = NULL, anonymized_at = $3 WHERE id = $1`,
    [e.id, `#${e.id}`, now()],
  );
  const users = await rows(db, 'SELECT id FROM users WHERE employee_id = $1', [e.id]);
  for (const u of users) {
    await revokeAllSessions(db, u.id);
    await db.query(
      `UPDATE users SET email = NULL, username = $2, first_name = NULL, last_name = NULL, password_hash = NULL, status = 'disabled',
              deleted_at = COALESCE(deleted_at, now()) WHERE id = $1`,
      [u.id, `former.user.${u.id}`],
    );
  }
  await audit(db, ctx, {
    action: 'employee.anonymize', entityType: 'employee', entityId: e.id, hotelId: access.homeHotelId,
    meta: { forced: !elapsed, ...(!elapsed ? { forceReason: input.reason } : {}) },
  });
  return { id: e.id, anonymizedAt: now(), forced: !elapsed };
}

/** Daily: disable logins and delete PINs of employees whose termination date has passed (R15). */
export async function disableTerminatedUsers(db: Db): Promise<number> {
  const today = todayIn('Europe/Berlin', now());
  const list = await rows(
    db,
    `SELECT DISTINCT e.id FROM employees e
      WHERE e.terminated_on IS NOT NULL AND e.terminated_on <= $1
        AND (EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id AND u.status <> 'disabled' AND u.deleted_at IS NULL)
             OR EXISTS (SELECT 1 FROM employee_pins p WHERE p.employee_id = e.id))`,
    [today],
  );
  for (const r of list) {
    await db.query(`UPDATE employees SET status = 'terminated' WHERE id = $1 AND status <> 'terminated'`, [r.id]);
    await deactivateTerminated(db, r.id);
  }
  return list.length;
}

/** Daily: delete closed inquiries after retention.inquiriesMonths (per routed hotel). */
export async function inquiryRetention(db: Db): Promise<number> {
  const hotels = await rows(db, 'SELECT id FROM hotels');
  let n = 0;
  for (const h of hotels) {
    const hotel = await loadHotel(db, h.id).catch(() => null);
    const months = hotel?.settings.retention.inquiriesMonths ?? 24;
    const cutoff = DateTime.fromJSDate(now()).minus({ months }).toJSDate();
    const res = await db.query(`DELETE FROM inquiries WHERE hotel_id = $1 AND status = 'closed' AND closed_at < $2`, [h.id, cutoff]);
    n += res.rowCount ?? 0;
  }
  return n;
}

/** Daily: remove expired/used tokens (refresh, invite/reset, pairing, punch). */
export async function tokenCleanup(db: Db): Promise<void> {
  const t = now();
  const old = new Date(t.getTime() - 7 * 86_400_000);
  await db.query('DELETE FROM refresh_tokens WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $2)', [t, old]);
  await db.query('DELETE FROM user_tokens WHERE expires_at < $1 OR (used_at IS NOT NULL AND used_at < $2)', [t, old]);
  await db.query('DELETE FROM kiosk_pairing_codes WHERE expires_at < $1', [old]);
  await db.query('DELETE FROM kiosk_punch_tokens WHERE expires_at < $1', [t]);
}
