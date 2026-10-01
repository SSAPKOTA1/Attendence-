import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { anon, as, device } from '../helpers/api';
import { setupWorld, World } from '../helpers/fixtures';
import { q, q1 } from '../helpers/db';
import { closePool, getPool } from '../../src/db/pool';
import { setNow } from '../../src/clock';
import { autoCloseForgottenClockOuts, markNeedsReview } from '../../src/services/attendance';

let w: World;
let dev: string;
const M1 = () => as(w.tokens.manager1);

beforeEach(async () => {
  w = await setupWorld();
  const code = await M1().post('/kiosk/pairing-codes', { hotelId: w.h1, deviceName: 'Tablet' });
  dev = (await anon.post('/kiosk/pair', { pairingCode: code.body.pairingCode })).body.deviceToken;
});
afterAll(() => closePool());

async function clockIn(employeeId: number, reason?: string) {
  const pin = (await M1().post(`/employees/${employeeId}/pin/reset`)).body.pin;
  const v = (await device(dev).post('/kiosk/verify', { employeeId, pin })).body;
  const r = await device(dev).post('/kiosk/punch', { punchToken: v.punchToken, action: 'clock_in', ...(reason ? { reason } : {}) });
  expect(r.status).toBe(201);
  return r.body.timeEntryId as number;
}
async function plan(employeeId: number, shiftId: number, date: string) {
  expect((await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId, shiftId, date })).status).toBe(201);
  await M1().post('/schedules/publish', { hotelId: w.h1, from: date, to: date });
}

describe('SPEC 1.13: forgotten clock-out on a planned shift is credited with the planned hours after 5 h', () => {
  it('closes at the planned end with the scheduled break, only once 5 h have passed', async () => {
    await plan(w.maria, w.early, '2026-10-01'); // 06:00-14:00 local = 04:00-12:00Z, 30 min break
    setNow('2026-10-01T04:00:00Z');
    const id = await clockIn(w.maria);
    setNow('2026-10-01T16:59:00Z'); // 4 h 59 after the planned end
    expect(await autoCloseForgottenClockOuts(getPool())).toBe(0);
    setNow('2026-10-01T17:01:00Z');
    expect(await autoCloseForgottenClockOuts(getPool())).toBe(1);
    const row = await q1('SELECT status, clock_out_at, break_minutes, source_out, anomalies FROM time_entries WHERE id = $1', [id]);
    expect(row.status).toBe('closed');
    expect(new Date(row.clock_out_at).toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(row.break_minutes).toBe(30);
    expect(row.source_out).toBe('system');
    expect(row.anomalies.map((a: any) => a.type)).toContain('auto_closed_planned_hours');
    const e = await as(w.tokens.maria).get(`/attendance/${id}`);
    expect(e.body.workedMinutes).toBe(450);
    expect((await q('SELECT 1 FROM notifications WHERE kind = $1 AND user_id = $2', ['needs_review_entry', w.manager1])).length).toBe(1);
    expect(await autoCloseForgottenClockOuts(getPool())).toBe(0); // idempotent
  });

  it('a late clock-in is credited from the real clock-in to the planned end', async () => {
    await plan(w.maria, w.early, '2026-10-01');
    setNow('2026-10-01T05:00:00Z');
    const id = await clockIn(w.maria);
    setNow('2026-10-01T18:00:00Z');
    await autoCloseForgottenClockOuts(getPool());
    const e = await as(w.tokens.maria).get(`/attendance/${id}`);
    expect(e.body.workedMinutes).toBe(420 - 30);
  });

  it('unplanned entries are never auto-closed (they go to needs_review)', async () => {
    setNow('2026-10-01T04:00:00Z');
    const id = await clockIn(w.maria, 'Covering a sick colleague');
    setNow('2026-10-01T20:00:00Z');
    expect(await autoCloseForgottenClockOuts(getPool())).toBe(0);
    expect(await markNeedsReview(getPool())).toBe(1);
    expect((await q1('SELECT status FROM time_entries WHERE id = $1', [id])).status).toBe('needs_review');
  });

  it('can be switched off per hotel and respects the attendance lock', async () => {
    await plan(w.maria, w.early, '2026-10-01');
    setNow('2026-10-01T04:00:00Z');
    const id = await clockIn(w.maria);
    await q(`UPDATE hotels SET attendance_locked_until = '2026-10-01' WHERE id = $1`, [w.h1]);
    setNow('2026-10-02T04:00:00Z');
    expect(await autoCloseForgottenClockOuts(getPool())).toBe(0);
    await q(`UPDATE hotels SET attendance_locked_until = NULL, settings = jsonb_set(settings, '{attendance,autoCloseAfterPlannedEndHours}', 'null') WHERE id = $1`, [w.h1]);
    expect(await autoCloseForgottenClockOuts(getPool())).toBe(0);
    expect((await q1('SELECT status FROM time_entries WHERE id = $1', [id])).status).toBe('open');
  });
});
