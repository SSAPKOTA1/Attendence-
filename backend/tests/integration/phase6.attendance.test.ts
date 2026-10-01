import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { anon, app, as, device } from '../helpers/api';
import { patchSettings, setupWorld, World } from '../helpers/fixtures';
import { q, q1 } from '../helpers/db';
import { closePool, getPool } from '../../src/db/pool';
import { setNow, advance } from '../../src/clock';
import { markNeedsReview } from '../../src/services/attendance';

let w: World;
const M1 = () => as(w.tokens.manager1);

async function pair(hotelId: number, tok: string, name = 'Front desk tablet') {
  const code = await as(tok).post('/kiosk/pairing-codes', { hotelId, deviceName: name });
  expect(code.status).toBe(201);
  const res = await anon.post('/kiosk/pair', { pairingCode: code.body.pairingCode });
  expect(res.status).toBe(200);
  return res.body.deviceToken as string;
}

async function pinFor(employeeId: number, tok = w.tokens.manager1) {
  const res = await as(tok).post(`/employees/${employeeId}/pin/reset`);
  expect(res.status).toBe(200);
  expect(res.body.pin).toMatch(/^\d{6}$/);
  return res.body.pin as string;
}

async function punch(dev: string, employeeId: number, pin: string, action: string, extra: Record<string, unknown> = {}) {
  const v = await device(dev).post('/kiosk/verify', { employeeId, pin });
  expect(v.status).toBe(200);
  return device(dev).post('/kiosk/punch', { punchToken: v.body.punchToken, reason: 'Covering for a colleague (test)', action, ...extra });
}

async function publishShift(employeeId: number, shiftId: number, date: string, hotelId?: number, tok?: string) {
  const res = await as(tok ?? w.tokens.manager1).post('/schedules', { hotelId: hotelId ?? w.h1, entryType: 'shift', employeeId, shiftId, date });
  expect(res.status).toBe(201);
  await as(tok ?? w.tokens.manager1).post('/schedules/publish', { hotelId: hotelId ?? w.h1, from: date, to: date });
  return res.body.id as number;
}

describe('Phase 6: kiosk and attendance', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('#41 pairing: valid / reused / expired code', async () => {
    const code = await M1().post('/kiosk/pairing-codes', { hotelId: w.h1, deviceName: 'Lobby' });
    expect(code.body.pairingCode).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{2}$/);
    const ok = await anon.post('/kiosk/pair', { pairingCode: code.body.pairingCode });
    expect(ok.status).toBe(200);
    expect(ok.body.deviceToken.length).toBeGreaterThanOrEqual(43);
    expect(ok.body.hotel).toEqual({ id: w.h1, name: 'Trip Inn Frankfurt', timezone: 'Europe/Berlin' });
    const stored = await q1('SELECT token_hash FROM kiosk_devices WHERE id = $1', [ok.body.device.id]);
    expect(stored.token_hash).not.toBe(ok.body.deviceToken);
    const reused = await anon.post('/kiosk/pair', { pairingCode: code.body.pairingCode });
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe('PAIRING_CODE_INVALID');
    const code2 = await M1().post('/kiosk/pairing-codes', { hotelId: w.h1, deviceName: 'Late' });
    advance(11 * 60_000);
    const expired = await anon.post('/kiosk/pair', { pairingCode: code2.body.pairingCode });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('PAIRING_CODE_INVALID');
  });

  it('#42 revoked device → 401 DEVICE_UNAUTHORIZED', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    expect((await device(dev).get('/kiosk/roster')).status).toBe(200);
    const list = await M1().get('/kiosk/devices');
    expect((await M1().delete(`/kiosk/devices/${list.body.data[0].id}`)).status).toBe(204);
    const res = await device(dev).get('/kiosk/roster');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('DEVICE_UNAUTHORIZED');
    expect((await device('nonsense').get('/kiosk/roster')).status).toBe(401);
  });

  it('#43 wrong PIN ×5 → attemptsLeft, then 423 PIN_LOCKED; manager unlocks', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const pin = await pinFor(w.maria);
    const wrong = pin === '000000' ? '111111' : '000000';
    const left: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await device(dev).post('/kiosk/verify', { employeeId: w.maria, pin: wrong });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_PIN');
      left.push(r.body.error.attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    const locked = await device(dev).post('/kiosk/verify', { employeeId: w.maria, pin });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('PIN_LOCKED');
    expect(locked.body.error.lockedUntil).toBeTruthy();
    expect((await M1().post(`/employees/${w.maria}/pin/unlock`)).status).toBe(204);
    expect((await device(dev).post('/kiosk/verify', { employeeId: w.maria, pin })).status).toBe(200);
    expect((await q(`SELECT 1 FROM audit_logs WHERE action = 'pin.locked'`)).length).toBe(1);
  });

  it('#44 clock in uses server time; a fake tablet time is ignored', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const pin = await pinFor(w.maria);
    setNow('2026-10-01T06:00:00.123Z');
    const res = await punch(dev, w.maria, pin, 'clock_in', { at: '2020-01-01T00:00:00Z', clockInAt: '2020-01-01T00:00:00Z' });
    expect(res.status).toBe(201);
    expect(res.body.at).toBe('2026-10-01T06:00:00.123Z');
    const row = await q1('SELECT clock_in_at FROM time_entries WHERE id = $1', [res.body.timeEntryId]);
    expect(new Date(row.clock_in_at).toISOString()).toBe('2026-10-01T06:00:00.123Z');
  });

  it('#45 punch token: reuse and expiry → 401 PUNCH_TOKEN_INVALID', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const pin = await pinFor(w.maria);
    const v = await device(dev).post('/kiosk/verify', { employeeId: w.maria, pin });
    expect((await device(dev).post('/kiosk/punch', { punchToken: v.body.punchToken, reason: 'Covering for a colleague (test)', action: 'clock_in' })).status).toBe(201);
    const reuse = await device(dev).post('/kiosk/punch', { punchToken: v.body.punchToken, reason: 'Covering for a colleague (test)', action: 'clock_out' });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('PUNCH_TOKEN_INVALID');
    const v2 = await device(dev).post('/kiosk/verify', { employeeId: w.maria, pin });
    advance(61_000);
    const expired = await device(dev).post('/kiosk/punch', { punchToken: v2.body.punchToken, reason: 'Covering for a colleague (test)', action: 'clock_out' });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('PUNCH_TOKEN_INVALID');
  });

  it('#46 clock in twice → 409 INVALID_PUNCH_STATE', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const pin = await pinFor(w.maria);
    expect((await punch(dev, w.maria, pin, 'clock_in')).status).toBe(201);
    const v = await device(dev).post('/kiosk/verify', { employeeId: w.maria, pin });
    expect(v.body.allowedActions).toEqual(['clock_out']);
    expect(v.body.status).toBe('in');
    const res = await device(dev).post('/kiosk/punch', { punchToken: v.body.punchToken, reason: 'Covering for a colleague (test)', action: 'clock_in' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_PUNCH_STATE');
  });

  it('#47 auto break: 8 h shift → 30, 4 h shift → 0', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    await publishShift(w.maria, w.early, '2026-10-01');
    await publishShift(w.jon, w.breakfast, '2026-10-01');
    const pm = await pinFor(w.maria);
    const pj = await pinFor(w.jon);
    setNow('2026-10-01T04:00:00Z'); // 06:00 local
    expect((await punch(dev, w.maria, pm, 'clock_in')).body.anomalies).toEqual([]);
    expect((await punch(dev, w.jon, pj, 'clock_in')).status).toBe(201);
    setNow('2026-10-01T08:00:00Z'); // 10:00 local
    const jOut = await punch(dev, w.jon, pj, 'clock_out');
    expect(jOut.status).toBe(201);
    setNow('2026-10-01T12:00:00Z'); // 14:00 local
    const mOut = await punch(dev, w.maria, pm, 'clock_out');
    expect(mOut.status).toBe(201);
    expect(mOut.body.workedMinutesToday).toBe(450);
    const m = await M1().get(`/attendance/${mOut.body.timeEntryId}`);
    expect(m.body).toMatchObject({ breakMinutes: 30, workedMinutes: 450, status: 'closed', sourceIn: 'kiosk', sourceOut: 'kiosk' });
    const j = await M1().get(`/attendance/${jOut.body.timeEntryId}`);
    expect(j.body).toMatchObject({ breakMinutes: 0, workedMinutes: 240 });
  });

  it('#48 clock in 45 min early: accepted, early_clock_in, timestamp unrounded', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const sid = await publishShift(w.maria, w.early, '2026-10-02');
    const pin = await pinFor(w.maria);
    setNow('2026-10-02T03:15:27.456Z'); // 05:15:27 local
    const res = await punch(dev, w.maria, pin, 'clock_in');
    expect(res.status).toBe(201);
    expect(res.body.anomalies).toEqual([{ type: 'early_clock_in', minutes: 45 }]);
    expect(res.body.at).toBe('2026-10-02T03:15:27.456Z');
    const row = await q1('SELECT schedule_id FROM time_entries WHERE id = $1', [res.body.timeEntryId]);
    expect(row.schedule_id).toBe(sid);
  });

  it('#49 unscheduled punch; punch during approved leave', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const pin = await pinFor(w.maria);
    const res = await punch(dev, w.maria, pin, 'clock_in');
    expect(res.body.anomalies).toEqual([{ type: 'unscheduled_work' }]);
    await M1().post(`/employees/${w.jon}/time-offs`, { type: 'annual_leave', startDate: '2026-10-01', endDate: '2026-10-02' });
    const pj = await pinFor(w.jon);
    const res2 = await punch(dev, w.jon, pj, 'clock_in');
    expect(res2.body.anomalies.map((a: any) => a.type)).toEqual(['unscheduled_work', 'during_time_off']);
  });

  it('#50 open 15 h → needs_review; clocking in → 409 ENTRY_NEEDS_REVIEW', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const pin = await pinFor(w.maria);
    setNow('2026-10-01T04:00:00Z');
    const entry = await punch(dev, w.maria, pin, 'clock_in');
    setNow('2026-10-01T19:00:00Z');
    expect(await markNeedsReview(getPool())).toBe(1);
    const row = await q1('SELECT status, clock_out_at FROM time_entries WHERE id = $1', [entry.body.timeEntryId]);
    expect(row).toEqual({ status: 'needs_review', clock_out_at: null });
    const v = await device(dev).post('/kiosk/verify', { employeeId: w.maria, pin });
    expect(v.body.allowedActions).toEqual([]);
    const res = await device(dev).post('/kiosk/punch', { punchToken: v.body.punchToken, reason: 'Covering for a colleague (test)', action: 'clock_in' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ENTRY_NEEDS_REVIEW');
    const live = await M1().get('/attendance/live');
    expect(live.body.needsReview.map((x: any) => x.timeEntryId)).toEqual([entry.body.timeEntryId]);
    const notes = await q(`SELECT 1 FROM notifications WHERE kind = 'needs_review_entry' AND user_id = $1`, [w.manager1]);
    expect(notes.length).toBe(1);
  });

  it('#51 staff correction request (with/without reason); manager approves with snapshot', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const pin = await pinFor(w.maria);
    setNow('2026-10-01T04:00:00Z');
    const e = await punch(dev, w.maria, pin, 'clock_in');
    setNow('2026-10-01T12:00:00Z');
    await punch(dev, w.maria, pin, 'clock_out');
    const noReason = await as(w.tokens.maria).post(`/attendance/${e.body.timeEntryId}/corrections`, { proposedClockOutAt: '2026-10-01T12:30:00Z' });
    expect(noReason.status).toBe(400);
    const req = await as(w.tokens.maria).post(`/attendance/${e.body.timeEntryId}/corrections`, { proposedClockOutAt: '2026-10-01T12:30:00Z', reason: 'Forgot to clock out after handover' });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('pending');
    const decided = await M1().patch(`/attendance/corrections/${req.body.id}`, { status: 'approved', decisionNote: 'ok' });
    expect(decided.status).toBe(200);
    expect(new Date(decided.body.originalClockOutAt).toISOString()).toBe('2026-10-01T12:00:00.000Z');
    const entry = await as(w.tokens.maria).get(`/attendance/${e.body.timeEntryId}`);
    expect(new Date(entry.body.clockOutAt).toISOString()).toBe('2026-10-01T12:30:00.000Z');
    expect(entry.body.corrections).toHaveLength(1);
    expect((await as(w.tokens.maria).get('/attendance/corrections')).body.data).toHaveLength(1);
    const notes = await q(`SELECT kind FROM notifications WHERE user_id = $1`, [w.uMaria]);
    expect(notes.map((n) => n.kind)).toContain('correction_decided');
  });

  it('#52 manager direct edit → approved correction row; staff direct edit → 403', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const pin = await pinFor(w.maria);
    setNow('2026-10-01T04:00:00Z');
    const e = await punch(dev, w.maria, pin, 'clock_in');
    setNow('2026-10-01T12:00:00Z');
    const staff = await as(w.tokens.maria).patch(`/attendance/${e.body.timeEntryId}`, { clockOutAt: '2026-10-01T11:00:00Z', reason: 'x' });
    expect(staff.status).toBe(403);
    const res = await M1().patch(`/attendance/${e.body.timeEntryId}`, { clockOutAt: '2026-10-01T11:00:00Z', breakMinutes: 30, reason: 'Forgotten clock-out, confirmed by shift lead' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'closed', breakMinutes: 30, workedMinutes: 390 });
    expect(res.body.corrections[0]).toMatchObject({ status: 'approved', originalClockOutAt: null, originalBreakMinutes: 0 });
  });

  it('#53 locked period: manager 423, admin with reason 200', async () => {
    const created = await M1().post('/attendance', { hotelId: w.h1, employeeId: w.maria, clockInAt: '2026-09-15T06:00:00Z', clockOutAt: '2026-09-15T14:00:00Z', breakMinutes: 30, reason: 'Kiosk outage' });
    expect(created.status).toBe(201);
    expect((await M1().put(`/hotels/${w.h1}/attendance-lock`, { lockedUntil: '2026-09-30' })).status).toBe(200);
    expect((await M1().put(`/hotels/${w.h1}/attendance-lock`, { lockedUntil: '2026-08-31' })).status).toBe(403);
    const mgr = await M1().patch(`/attendance/${created.body.id}`, { clockOutAt: '2026-09-15T15:00:00Z', reason: 'late fix' });
    expect(mgr.status).toBe(423);
    expect(mgr.body.error.code).toBe('PERIOD_LOCKED');
    const newEntry = await M1().post('/attendance', { hotelId: w.h1, employeeId: w.jon, clockInAt: '2026-09-16T06:00:00Z', clockOutAt: '2026-09-16T14:00:00Z', reason: 'x' });
    expect(newEntry.status).toBe(423);
    const admin = await as(w.tokens.admin).patch(`/attendance/${created.body.id}`, { clockOutAt: '2026-09-15T15:00:00Z', reason: 'Payroll office request #42' });
    expect(admin.status).toBe(200);
    const audit = await q1(`SELECT meta FROM audit_logs WHERE action = 'attendance.correction_direct' ORDER BY id DESC LIMIT 1`);
    expect(audit.meta.lockOverride).toBe(true);
  });

  it('#54 live board: clocked in and expected-not-arrived with minutesLate', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    await publishShift(w.maria, w.early, '2026-10-01');
    await publishShift(w.jon, w.early, '2026-10-01');
    const pin = await pinFor(w.maria);
    setNow('2026-10-01T04:00:00Z');
    await punch(dev, w.maria, pin, 'clock_in');
    setNow('2026-10-01T04:14:00Z');
    const res = await M1().get(`/attendance/live?hotelId=${w.h1}`);
    expect(res.status).toBe(200);
    expect(res.body.clockedIn.map((c: any) => c.employee)).toEqual([{ id: w.maria, displayName: 'Maria G.' }]);
    expect(res.body.clockedIn[0].shift).toEqual({ name: 'Early' });
    expect(res.body.expectedNotArrived).toEqual([{ scheduleId: expect.any(Number), employee: { id: w.jon, displayName: 'Jon S.' }, shift: { name: 'Early', startTime: '06:00' }, minutesLate: 14 }]);
    setNow('2026-10-01T12:30:00Z');
    const later = await M1().get(`/attendance/live?hotelId=${w.h1}`);
    expect(later.body.noShows.map((n: any) => n.employee.id)).toEqual([w.jon]);
  });

  it('#55 time account with opening balance', async () => {
    await M1().put(`/employees/${w.maria}/work-targets`, { openingBalanceHours: 10, balanceStartDate: '2026-09-01' });
    for (const d of ['2026-09-07', '2026-09-08']) {
      expect((await M1().post('/attendance', { hotelId: w.h1, employeeId: w.maria, clockInAt: `${d}T06:00:00Z`, clockOutAt: `${d}T14:00:00Z`, breakMinutes: 30, reason: 'import' })).status).toBe(201);
    }
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-09-15', endDate: '2026-09-15' });
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'unpaid_leave', startDate: '2026-10-02', endDate: '2026-10-02' });
    const res = await as(w.tokens.maria).get('/employees/me/time-account?from=2026-09&to=2026-10');
    expect(res.status).toBe(200);
    expect(res.body.months[0]).toEqual({ month: '2026-09', workedHours: 15, creditedHours: 8, targetHours: 160, deltaHours: -137, openEntries: 0 });
    expect(res.body.months[1]).toMatchObject({ month: '2026-10', workedHours: 0, creditedHours: 0, targetHours: 152.73 });
    expect(res.body.balanceHours).toBe(-279.73);
  });

  it('#56 kiosk roster payload is minimal', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    await publishShift(w.maria, w.mid, '2026-10-01');
    const res = await device(dev).get('/kiosk/roster');
    expect(res.status).toBe(200);
    expect(res.body.serverTime).toBe('2026-10-01T06:00:00.000Z');
    expect(res.body.employees).toEqual([{ id: w.maria, displayName: 'Maria G.', status: 'not_in', todayShifts: [{ name: 'Mid', startTime: '10:00', endTime: '18:00' }] }]);
    const search = await device(dev).get('/kiosk/roster?search=jon');
    expect(search.body.employees.map((e: any) => e.displayName)).toContain('Jon S.');
    expect(JSON.stringify(search.body)).not.toMatch(/hourly|email|phone|birth/i);
  });

  it('#73 kiosk at hotel 2: same PIN works for assigned staff, generic error otherwise', async () => {
    const dev2 = await pair(w.h2, w.tokens.manager2);
    const pf = await pinFor(w.flo);
    const pm = await pinFor(w.maria);
    expect((await device(dev2).post('/kiosk/verify', { employeeId: w.flo, pin: pf })).status).toBe(200);
    const res = await device(dev2).post('/kiosk/verify', { employeeId: w.maria, pin: pm });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_PIN');
    const unknown = await device(dev2).post('/kiosk/verify', { employeeId: 99999, pin: '123456' });
    expect(unknown.status).toBe(401);
    expect(Object.keys(unknown.body.error).sort()).toEqual(Object.keys(res.body.error).sort());
  });

  it('#74 open entry at hotel 1 blocks hotel 2; rostered at hotel 1 → scheduled_elsewhere', async () => {
    const dev1 = await pair(w.h1, w.tokens.manager1);
    const dev2 = await pair(w.h2, w.tokens.manager2);
    const pin = await pinFor(w.flo);
    expect((await punch(dev1, w.flo, pin, 'clock_in')).status).toBe(201);
    const v = await device(dev2).post('/kiosk/verify', { employeeId: w.flo, pin });
    const blocked = await device(dev2).post('/kiosk/punch', { punchToken: v.body.punchToken, reason: 'Covering for a colleague (test)', action: 'clock_in' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INVALID_PUNCH_STATE');
    advance(3_600_000);
    await punch(dev1, w.flo, pin, 'clock_out');
    await publishShift(w.flo, w.late, '2026-10-01');
    advance(60_000);
    const elsewhere = await punch(dev2, w.flo, pin, 'clock_in');
    expect(elsewhere.status).toBe(201);
    expect(elsewhere.body.anomalies).toEqual([{ type: 'unscheduled_work' }, { type: 'scheduled_elsewhere', hotelName: 'Trip Inn Frankfurt', shiftName: 'Late' }]);
  });

  it('#106 terminating an employee disables login, sessions and PIN', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const pin = await pinFor(w.maria);
    const login = await anon.post('/auth/login', { login: 'maria@tripinn.test', password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
    const res = await M1().patch(`/employees/${w.maria}`, { status: 'terminated' });
    expect(res.status).toBe(200);
    expect(res.body.terminatedOn).toBe('2026-10-01');
    expect((await q1('SELECT status FROM users WHERE id = $1', [w.uMaria])).status).toBe('disabled');
    expect((await as(w.tokens.maria).get('/auth/me')).status).toBe(401);
    expect((await anon.post('/auth/refresh', { refreshToken: login.body.refreshToken })).status).toBe(401);
    const v = await device(dev).post('/kiosk/verify', { employeeId: w.maria, pin });
    expect(v.status).toBe(401);
    expect(v.body.error.code).toBe('INVALID_PIN');
    const roster = await device(dev).get('/kiosk/roster?search=maria');
    expect(roster.body.employees).toEqual([]);
  });

  it('#112 payroll export for a sample month', async () => {
    const mk = (inAt: string, outAt: string | null, breakMinutes = 30) =>
      M1().post('/attendance', { hotelId: w.h1, employeeId: w.maria, clockInAt: inAt, clockOutAt: outAt, breakMinutes, reason: 'import' });
    expect((await mk('2026-05-01T06:00:00Z', '2026-05-01T14:00:00Z')).status).toBe(201); // Friday, public holiday 08–16 local
    expect((await mk('2026-05-03T08:00:00Z', '2026-05-03T16:00:00Z')).status).toBe(201); // Sunday 10–18 local
    expect((await mk('2026-05-06T20:00:00Z', '2026-05-07T04:00:00Z', 60)).status).toBe(201); // 22–06 local
    expect((await mk('2026-05-09T06:00:00Z', '2026-05-09T14:00:00Z')).status).toBe(201); // Saturday 08–16 local
    expect((await mk('2026-05-28T06:00:00Z', null)).status).toBe(201); // still open
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-05-11', endDate: '2026-05-12' });
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'sick_leave', startDate: '2026-05-18', endDate: '2026-05-18' });
    const adminEntry = await as(w.tokens.admin).post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-05-04', allowPast: true });
    expect(adminEntry.status).toBe(201);
    await as(w.tokens.admin).post('/schedules/publish', { hotelId: w.h1, from: '2026-05-01', to: '2026-05-31' });
    const res = await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-05&format=json`);
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual(['period_not_locked']);
    expect(res.body.data).toEqual([
      {
        employeeId: w.maria, employeeNumber: 'P100', lastName: 'Garcia', firstName: 'Maria', employmentType: 'full_time', payType: 'salary',
        workedMinutes: 1770, plannedMinutes: 450, creditedAnnualMinutes: 960, creditedSickMinutes: 480, creditedSchoolMinutes: 0,
        // paid public holidays 14 and 25 May (1 May was worked → no holiday pay, holiday supplement instead)
        creditedPublicHolidayMinutes: 960,
        absenceDaysAnnual: 2, absenceDaysSick: 1, absenceDaysUnpaid: 0,
        // break deducted proportionally: night 420 × 420/480 = 367.5 → 368; the other supplements 480 − 30 = 450
        nightMinutes: 368, saturdayMinutes: 450, sundayMinutes: 450, holidayMinutes: 450,
        openOrReviewEntries: 1, unapprovedEntries: 0, timeAccountDeltaMinutes: -5430,
      },
    ]);
    const csv = await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-05&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('employeeNumber,lastName,firstName,employmentType,payType,workedMinutes,plannedMinutes,creditedAnnualMinutes,creditedSickMinutes,creditedSchoolMinutes,creditedPublicHolidayMinutes,absenceDaysAnnual,absenceDaysSick,absenceDaysUnpaid,nightMinutes,saturdayMinutes,sundayMinutes,holidayMinutes,openOrReviewEntries,unapprovedEntries,timeAccountDeltaMinutes');
    const att = await M1().get(`/attendance/export?hotelId=${w.h1}&from=2026-05-01&to=2026-05-31&format=csv`);
    expect(att.status).toBe(200);
    expect(att.text.trim().split('\r\n')).toHaveLength(6);
    await M1().put(`/hotels/${w.h1}/attendance-lock`, { lockedUntil: '2026-05-31' });
    expect((await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-05&format=json`)).body.warnings).toEqual([]);
  });

  it('#116 DATEV export: golden file, unmapped wage type, missing personnel number', async () => {
    const mk = (inAt: string, outAt: string, breakMinutes = 30) =>
      M1().post('/attendance', { hotelId: w.h1, employeeId: w.maria, clockInAt: inAt, clockOutAt: outAt, breakMinutes, reason: 'import' });
    await mk('2026-05-01T06:00:00Z', '2026-05-01T14:00:00Z');
    await mk('2026-05-03T08:00:00Z', '2026-05-03T16:00:00Z');
    await mk('2026-05-06T20:00:00Z', '2026-05-07T04:00:00Z', 60);
    await mk('2026-05-09T06:00:00Z', '2026-05-09T14:00:00Z');
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-05-11', endDate: '2026-05-12' });
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'sick_leave', startDate: '2026-05-18', endDate: '2026-05-18' });
    const unmapped = await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-05&format=datev`);
    expect(unmapped.status).toBe(422);
    expect(unmapped.body.error.code).toBe('PAYROLL_MAPPING_INCOMPLETE');
    // LODAS is the default product with the layout and suggested wage types pre-filled: only the firm's own numbers are missing
    expect(unmapped.body.error.details.map((d: any) => d.field)).toEqual(['payroll.datev.consultantNumber', 'payroll.datev.clientNumber']);
    await patchSettings(w.h1, (s) => { s.payroll.datev.consultantNumber = '1234567'; s.payroll.datev.clientNumber = '12345'; });
    const defaults = await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-05&format=datev`);
    expect(defaults.status).toBe(200); // works with the suggested wage types, nothing else to configure
    const text = defaults.text as string;
    expect(text).toContain('BeraterNr=1234567');
    expect(text).toMatch(/10;P100;31\.05\.2026;29,50;1;2000;;;"Stunden";/);
    expect(text).toMatch(/;1;2100;;;"Nacht";/);
    expect((await M1().get(`/hotels/${w.h1}/settings`)).body.payroll.datev.product).toBe('lodas');
    await patchSettings(w.h1, (s) => {
      s.payroll.datev = {
        product: 'lodas', consultantNumber: '1234567', clientNumber: '12345', encoding: 'windows-1252',
        headerTemplate: '[Allgemein]\n; Export für LODAS (Testmandant)\nZiel=LODAS\nVersion_SST=1.0\nBeraterNr={consultantNumber}\nMandantenNr={clientNumber}\nAbrechnungszeitraum={month}',
        recordDescriptionTemplate: '[Satzbeschreibung]\n10;u_lod_bwd_buchung_standard;pnr#bwd;abrechnung_zeitraum#bwd;buchungswert#bwd;buchungsschluessel#bwd;la_eigene#bwd;;;bs_wert_butab#bwd;\n[Bewegungsdaten]',
        lineTemplate: '10;{pnr};{date};{value};{key};{wageType};;;"{note}";',
        wageTypes: { worked: '100', annualLeave: '200', sick: '300', school: '400', publicHoliday: '530', night: null, saturday: '505', sunday: '510', holiday: '520' },
      };
    });
    // a cleared wage type falls back to the suggested number instead of blocking the export
    const clearedNight = await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-05&format=datev`);
    expect(clearedNight.status).toBe(200);
    expect(clearedNight.text).toMatch(/;1;2100;;;"Nacht";/);
    await patchSettings(w.h1, (s) => (s.payroll.datev.wageTypes.night = '500'));
    const file = await request(app)
      .get(`/api/v1/hotels/${w.h1}/payroll-export?month=2026-05&format=datev`)
      .set('Authorization', `Bearer ${w.tokens.manager1}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('text/plain; charset=windows-1252');
    const golden = fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'datev-2026-05.golden.txt'));
    expect((file.body as Buffer).equals(golden)).toBe(true);
    await q('UPDATE employees SET employee_number = NULL WHERE id = $1', [w.maria]);
    const noPnr = await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-05&format=datev`);
    expect(noPnr.status).toBe(422);
    expect(noPnr.body.error.code).toBe('VALIDATION_ERROR');
    expect(noPnr.body.error.details[0]).toMatchObject({ field: 'employeeNumber', employeeId: w.maria });
  });

  it('recorded break mode, own PIN and staff attendance view', async () => {
    await patchSettings(w.h1, (s) => (s.attendance.breakMode = 'recorded'));
    const dev = await pair(w.h1, w.tokens.manager1);
    const own = await as(w.tokens.maria).put('/employees/me/pin', { currentPassword: 'correct-horse-battery', newPin: '482913' });
    expect(own.status).toBe(204);
    setNow('2026-10-01T04:00:00Z');
    await punch(dev, w.maria, '482913', 'clock_in');
    setNow('2026-10-01T07:00:00Z');
    expect((await punch(dev, w.maria, '482913', 'break_start')).status).toBe(201);
    setNow('2026-10-01T07:20:00Z');
    const v = await device(dev).post('/kiosk/verify', { employeeId: w.maria, pin: '482913' });
    expect(v.body.status).toBe('on_break');
    expect(v.body.allowedActions).toEqual(['break_end', 'clock_out']);
    expect((await device(dev).post('/kiosk/punch', { punchToken: v.body.punchToken, reason: 'Covering for a colleague (test)', action: 'break_end' })).status).toBe(201);
    setNow('2026-10-01T12:00:00Z');
    const out = await punch(dev, w.maria, '482913', 'clock_out');
    expect(out.body.anomalies.map((a: any) => a.type)).toContain('missing_break');
    const list = await as(w.tokens.maria).get('/attendance?from=2026-10-01&to=2026-10-01');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ breakMinutes: 20, workedMinutes: 460 });
    expect((await as(w.tokens.maria).get(`/attendance?from=2026-10-01&to=2026-10-01&employeeId=${w.jon}`)).status).toBe(404);
  });
});
