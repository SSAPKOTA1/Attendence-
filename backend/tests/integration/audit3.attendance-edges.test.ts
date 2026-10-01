import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { anon, as, device } from '../helpers/api';
import { createEmployee, patchSettings, setupWorld, World } from '../helpers/fixtures';
import { q, q1 } from '../helpers/db';
import { closePool, getPool } from '../../src/db/pool';
import { setNow, advance } from '../../src/clock';
import { markNeedsReview } from '../../src/services/attendance';

let w: World;
const M1 = () => as(w.tokens.manager1);
const M2 = () => as(w.tokens.manager2);

async function pair(hotelId: number, tok: string) {
  const code = await as(tok).post('/kiosk/pairing-codes', { hotelId, deviceName: 'Tablet' });
  return (await anon.post('/kiosk/pair', { pairingCode: code.body.pairingCode })).body.deviceToken as string;
}
async function pin(employeeId: number, tok = w.tokens.manager1) {
  return (await as(tok).post(`/employees/${employeeId}/pin/reset`)).body.pin as string;
}
async function punch(dev: string, employeeId: number, p: string, action: string) {
  const v = await device(dev).post('/kiosk/verify', { employeeId, pin: p });
  expect(v.status).toBe(200);
  return device(dev).post('/kiosk/punch', { punchToken: v.body.punchToken, reason: 'Covering for a colleague (test)', action });
}
async function publish(employeeId: number, shiftId: number, date: string, hotelId = w.h1, tok = w.tokens.manager1) {
  const r = await as(tok).post('/schedules', { hotelId, entryType: 'shift', employeeId, shiftId, date });
  expect(r.status).toBe(201);
  await as(tok).post('/schedules/publish', { hotelId, from: date, to: date });
  return r.body.id as number;
}

describe('audit 3: attendance, kiosk, payroll, concurrency', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('split day: second punch pair links to the second shift; day total and anomalies are right', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const first = await publish(w.maria, w.breakfast, '2026-10-01');
    const second = await publish(w.maria, w.dinner, '2026-10-01');
    const p = await pin(w.maria);
    setNow('2026-10-01T04:00:00Z'); // 06:00
    expect((await punch(dev, w.maria, p, 'clock_in')).body.anomalies).toEqual([]);
    setNow('2026-10-01T08:00:00Z'); // 10:00
    const out1 = await punch(dev, w.maria, p, 'clock_out');
    expect(out1.body.workedMinutesToday).toBe(240);
    setNow('2026-10-01T15:00:00Z'); // 17:00
    const in2 = await punch(dev, w.maria, p, 'clock_in');
    expect(in2.body.anomalies).toEqual([]);
    setNow('2026-10-01T19:00:00Z'); // 21:00
    const out2 = await punch(dev, w.maria, p, 'clock_out');
    expect(out2.body.workedMinutesToday).toBe(480);
    const links = await q('SELECT schedule_id FROM time_entries ORDER BY id');
    expect(links.map((l) => l.schedule_id)).toEqual([first, second]);
  });

  it('night shift: clock-in 22:00, clock-out 06:00 next day links the shift and belongs to the clock-in day', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const sid = await publish(w.maria, w.night, '2026-10-02');
    const p = await pin(w.maria);
    setNow('2026-10-02T20:00:00Z'); // 22:00 CEST
    const inn = await punch(dev, w.maria, p, 'clock_in');
    expect(inn.body.anomalies).toEqual([]);
    setNow('2026-10-03T04:00:00Z'); // 06:00 CEST next day
    const roster = await device(dev).get('/kiosk/roster');
    expect(roster.body.employees[0]).toMatchObject({ id: w.maria, status: 'in' }); // yesterday's night shift still listed
    const out = await punch(dev, w.maria, p, 'clock_out');
    expect(out.status).toBe(201);
    const row = await q1('SELECT schedule_id, break_minutes, status FROM time_entries WHERE id = $1', [out.body.timeEntryId]);
    expect(row).toEqual({ schedule_id: sid, break_minutes: 60, status: 'closed' });
    const list = await M1().get('/attendance?from=2026-10-02&to=2026-10-02');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].workedMinutes).toBe(420);
    expect((await M1().get('/attendance?from=2026-10-03&to=2026-10-03')).body.data).toHaveLength(0);
  });

  it('kiosk roster window: 2 h before start until end', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    await publish(w.maria, w.late, '2026-10-01'); // 14–22 local = 12:00–20:00Z
    const at = async (iso: string) => {
      setNow(iso);
      return (await device(dev).get('/kiosk/roster')).body.employees.map((e: any) => e.id);
    };
    expect(await at('2026-10-01T09:59:00Z')).toEqual([]); // 11:59 local: more than 2 h before
    expect(await at('2026-10-01T10:01:00Z')).toEqual([w.maria]);
    expect(await at('2026-10-01T19:59:00Z')).toEqual([w.maria]);
    expect(await at('2026-10-01T20:01:00Z')).toEqual([]);
  });

  it('kiosk IP allow-list', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    await patchSettings(w.h1, (s) => (s.attendance.kioskAllowedIps = ['10.9.9.9']));
    const blocked = await device(dev).get('/kiosk/roster');
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.code).toBe('DEVICE_UNAUTHORIZED');
    await patchSettings(w.h1, (s) => (s.attendance.kioskAllowedIps = ['127.0.0.1']));
    expect((await device(dev).get('/kiosk/roster')).status).toBe(200);
  });

  it('pairing codes: other hotel 404, case/dash-insensitive entry, one device per code', async () => {
    expect((await M1().post('/kiosk/pairing-codes', { hotelId: w.h2, deviceName: 'x' })).status).toBe(404);
    const c = await M1().post('/kiosk/pairing-codes', { hotelId: w.h1, deviceName: 'Lobby' });
    const typed = c.body.pairingCode.toLowerCase().replace(/-/g, ' ');
    expect((await anon.post('/kiosk/pair', { pairingCode: typed })).status).toBe(200);
    expect((await anon.post('/kiosk/pair', { pairingCode: c.body.pairingCode })).status).toBe(400);
    const dev = await M1().get('/kiosk/devices');
    expect(dev.body.data).toHaveLength(1);
    expect((await M2().delete(`/kiosk/devices/${dev.body.data[0].id}`)).status).toBe(404);
  });

  it('minors on the tablet: outside-hours clock-in and over-limit day notify the managers, never block', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const p = await pin(w.mia);
    setNow('2026-10-01T03:30:00Z'); // 05:30 local, before 06:00
    const inn = await punch(dev, w.mia, p, 'clock_in');
    expect(inn.status).toBe(201);
    expect(inn.body.anomalies.map((a: any) => a.type)).toContain('minor_outside_hours');
    setNow('2026-10-01T14:30:00Z'); // 16:30 local: 11 h
    const out = await punch(dev, w.mia, p, 'clock_out');
    expect(out.body.anomalies.map((a: any) => a.type)).toEqual(expect.arrayContaining(['minor_limit_exceeded', 'exceeds_daily_max']));
    const notes = await q(`SELECT user_id FROM notifications WHERE kind = 'needs_review_entry' ORDER BY id`);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.every((n) => [w.manager1, w.regional].includes(n.user_id))).toBe(true);
  });

  it('needs_review threshold is exact; manager closes the entry with a correction; kiosk works again', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const p = await pin(w.maria);
    setNow('2026-10-01T04:00:00Z');
    const inn = await punch(dev, w.maria, p, 'clock_in');
    setNow('2026-10-01T17:59:00Z'); // 13 h 59
    expect(await markNeedsReview(getPool())).toBe(0);
    setNow('2026-10-01T18:01:00Z');
    expect(await markNeedsReview(getPool())).toBe(1);
    expect(await markNeedsReview(getPool())).toBe(0); // idempotent
    const closed = await M1().patch(`/attendance/${inn.body.timeEntryId}`, { clockOutAt: '2026-10-01T12:00:00Z', breakMinutes: 30, reason: 'Forgot to clock out, confirmed' });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', workedMinutes: 450 });
    expect((await punch(dev, w.maria, p, 'clock_in')).status).toBe(201);
  });

  it('corrections: reject, cancel, double decision, invalid and overlapping proposals', async () => {
    const a = await M1().post('/attendance', { hotelId: w.h1, employeeId: w.maria, clockInAt: '2026-09-07T06:00:00Z', clockOutAt: '2026-09-07T10:00:00Z', reason: 'x' });
    await M1().post('/attendance', { hotelId: w.h1, employeeId: w.maria, clockInAt: '2026-09-07T12:00:00Z', clockOutAt: '2026-09-07T14:00:00Z', reason: 'x' });
    const mk = (body: Record<string, unknown>) => as(w.tokens.maria).post(`/attendance/${a.body.id}/corrections`, { reason: 'please', ...body });
    const rejected = await mk({ proposedClockOutAt: '2026-09-07T11:00:00Z' });
    expect((await M1().patch(`/attendance/corrections/${rejected.body.id}`, { status: 'rejected', decisionNote: 'no' })).body.status).toBe('rejected');
    expect((await M1().patch(`/attendance/corrections/${rejected.body.id}`, { status: 'approved' })).body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect((await M1().get(`/attendance/${a.body.id}`)).body.clockOutAt).toBe('2026-09-07T10:00:00.000Z');
    const cancel = await mk({ proposedBreakMinutes: 15 });
    expect((await as(w.tokens.jon).patch(`/attendance/corrections/${cancel.body.id}`, { status: 'cancelled' })).status).toBe(404);
    expect((await as(w.tokens.maria).patch(`/attendance/corrections/${cancel.body.id}`, { status: 'approved' })).status).toBe(403);
    expect((await as(w.tokens.maria).patch(`/attendance/corrections/${cancel.body.id}`, { status: 'cancelled' })).body.status).toBe('cancelled');
    const invalid = await mk({ proposedClockOutAt: '2026-09-07T05:00:00Z' }); // before clock-in
    const bad = await M1().patch(`/attendance/corrections/${invalid.body.id}`, { status: 'approved' });
    expect(bad.status).toBe(400);
    expect((await M1().get(`/attendance/corrections?status=pending`)).body.data.map((c: any) => c.id)).toContain(invalid.body.id); // rolled back: still pending
    const overlap = await mk({ proposedClockOutAt: '2026-09-07T13:00:00Z' }); // runs into the 12:00 entry
    const clash = await M1().patch(`/attendance/corrections/${overlap.body.id}`, { status: 'approved' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('TIME_ENTRY_OVERLAP');
    expect((await as(w.tokens.maria).post(`/attendance/${a.body.id}/corrections`, { proposedClockOutAt: '2026-09-07T11:00:00Z' })).status).toBe(400);
    expect((await as(w.tokens.jon).post(`/attendance/${a.body.id}/corrections`, { proposedClockOutAt: '2026-09-07T11:00:00Z', reason: 'x' })).status).toBe(404);
  });

  it('manual entries: overlap, future, unassigned hotel, and period-lock boundary', async () => {
    const base = { hotelId: w.h1, employeeId: w.maria, reason: 'import' };
    expect((await M1().post('/attendance', { ...base, clockInAt: '2026-09-07T06:00:00Z', clockOutAt: '2026-09-07T14:00:00Z' })).status).toBe(201);
    const clash = await M1().post('/attendance', { ...base, clockInAt: '2026-09-07T13:00:00Z', clockOutAt: '2026-09-07T15:00:00Z' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('TIME_ENTRY_OVERLAP');
    expect((await M1().post('/attendance', { ...base, clockInAt: '2026-10-05T06:00:00Z' })).status).toBe(400); // future
    expect((await M1().post('/attendance', { ...base, clockInAt: '2026-09-08T06:00:00Z', clockOutAt: '2026-09-08T05:00:00Z' })).status).toBe(400);
    expect((await M1().post('/attendance', { ...base, clockInAt: '2026-09-08T06:00:00Z', clockOutAt: '2026-09-08T14:00:00Z', breakMinutes: 600 })).status).toBe(400);
    expect((await M2().post('/attendance', { hotelId: w.h2, employeeId: w.maria, clockInAt: '2026-09-09T06:00:00Z', reason: 'x' })).status).toBe(404);
    expect((await as(w.tokens.regional).post('/attendance', { hotelId: w.h2, employeeId: w.maria, clockInAt: '2026-09-09T06:00:00Z', reason: 'x' })).body.error.code).toBe('EMPLOYEE_NOT_ASSIGNED_TO_HOTEL');
    // lock boundary: the locked date itself is frozen, the next day is open
    await M1().put(`/hotels/${w.h1}/attendance-lock`, { lockedUntil: '2026-09-10' });
    expect((await M1().post('/attendance', { ...base, clockInAt: '2026-09-10T06:00:00Z', clockOutAt: '2026-09-10T14:00:00Z' })).status).toBe(423);
    expect((await M1().post('/attendance', { ...base, clockInAt: '2026-09-11T06:00:00Z', clockOutAt: '2026-09-11T14:00:00Z' })).status).toBe(201);
    // 22:30Z on the 10th is already the 11th in Frankfurt (00:30 local): not locked, and free of overlaps
    expect((await M1().post('/attendance', { ...base, clockInAt: '2026-09-10T22:30:00Z', clockOutAt: '2026-09-10T23:30:00Z' })).status).toBe(201);
    // 21:30Z on the 10th is 23:30 local on the 10th: locked
    expect((await M1().post('/attendance', { ...base, clockInAt: '2026-09-10T21:00:00Z', clockOutAt: '2026-09-10T21:30:00Z' })).status).toBe(423);
  });

  it('live board: attendanceRequired=false and absent staff are never flagged as no-show', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    void dev;
    await q('UPDATE employees SET attendance_required = false WHERE id = $1', [w.jon]);
    await publish(w.jon, w.early, '2026-10-01');
    await publish(w.maria, w.early, '2026-10-01');
    await publish(w.flo, w.early, '2026-10-01');
    await M1().post(`/employees/${w.flo}/time-offs`, { type: 'sick_leave', startDate: '2026-10-01', endDate: '2026-10-01', unassignConflicts: false });
    setNow('2026-10-01T13:00:00Z'); // 15:00 local, shift ended 14:00
    const live = await M1().get('/attendance/live');
    expect(live.body.noShows.map((n: any) => n.employee.id)).toEqual([w.maria]);
    expect(live.body.expectedNotArrived).toEqual([]);
  });

  it('time account: balance start mid-month, hourly workers, multi-month ranges', async () => {
    await M1().put(`/employees/${w.maria}/work-targets`, { openingBalanceHours: 5, balanceStartDate: '2026-09-15' });
    const r = await as(w.tokens.maria).get('/employees/me/time-account?from=2026-08&to=2026-10');
    expect(r.body.months.map((m: any) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    // balance counts from the start month (Sep): 5 h opening − 160 h (Sep target) − 160 h (Oct has 22 weekdays, no weekday holiday)
    expect(r.body.months[1]).toMatchObject({ targetHours: 160, workedHours: 0, deltaHours: -160 });
    expect(r.body.months[2]).toMatchObject({ targetHours: 160, deltaHours: -160 });
    expect(r.body.balanceHours).toBe(-315);
    expect((await as(w.tokens.maria).get('/employees/me/time-account?from=2026-13')).status).toBe(400);
  });

  it('payroll: floating staff are paid per hotel without double counting; filters and quoting', async () => {
    await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.flo, shiftId: w.early, date: '2026-05-04', allowPast: true }).catch(() => undefined);
    await as(w.tokens.admin).post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.flo, shiftId: w.early, date: '2026-05-04', allowPast: true });
    await M1().post('/attendance', { hotelId: w.h1, employeeId: w.flo, clockInAt: '2026-05-04T04:00:00Z', clockOutAt: '2026-05-04T12:30:00Z', breakMinutes: 30, reason: 'x' });
    await M2().post('/attendance', { hotelId: w.h2, employeeId: w.flo, clockInAt: '2026-05-05T04:00:00Z', clockOutAt: '2026-05-05T12:00:00Z', breakMinutes: 30, reason: 'x' });
    await M1().post(`/employees/${w.flo}/time-offs`, { type: 'annual_leave', startDate: '2026-05-11', endDate: '2026-05-11' });
    const h1 = (await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-05&format=json`)).body.data.find((r: any) => r.employeeId === w.flo);
    const h2 = (await M2().get(`/hotels/${w.h2}/payroll-export?month=2026-05&format=json`)).body.data.find((r: any) => r.employeeId === w.flo);
    expect(h1.workedMinutes).toBe(480);
    expect(h2.workedMinutes).toBe(450);
    expect(h1.creditedAnnualMinutes).toBe(480); // credits and absence days only at the home hotel
    expect(h2.creditedAnnualMinutes).toBe(0);
    expect(h2.absenceDaysAnnual).toBe(0);
    expect(h2.timeAccountDeltaMinutes).toBe(0);
    expect((await M2().get(`/hotels/${w.h1}/payroll-export?month=2026-05`)).status).toBe(404);
    expect((await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-13`)).status).toBe(400);
    await q(`UPDATE employees SET last_name = 'Weber, "Jr"' WHERE id = $1`, [w.flo]);
    const csv = await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-05&format=csv`);
    expect(csv.text).toContain('"Weber, ""Jr"""');
    expect((await as(w.tokens.maria).get(`/hotels/${w.h1}/payroll-export?month=2026-05`)).status).toBe(403);
  });

  it('concurrency: 15 parallel clock-ins for one employee create exactly one open entry', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const p = await pin(w.maria);
    const tokens = [];
    for (let i = 0; i < 15; i++) tokens.push((await device(dev).post('/kiosk/verify', { employeeId: w.maria, pin: p })).body.punchToken);
    const res = await Promise.all(tokens.map((t) => device(dev).post('/kiosk/punch', { punchToken: t, reason: 'Covering for a colleague (test)', action: 'clock_in' })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(14);
    expect((await q(`SELECT 1 FROM time_entries WHERE status = 'open'`)).length).toBe(1);
  });

  it('concurrency: wrong PINs in parallel are counted exactly and lock the PIN', async () => {
    const dev = await pair(w.h1, w.tokens.manager1);
    const p = await pin(w.maria);
    const wrong = p === '000000' ? '111111' : '000000';
    const res = await Promise.all(Array.from({ length: 8 }, () => device(dev).post('/kiosk/verify', { employeeId: w.maria, pin: wrong })));
    expect(res.filter((r) => r.status === 401)).toHaveLength(5);
    expect(res.filter((r) => r.status === 423)).toHaveLength(3);
    expect((await device(dev).post('/kiosk/verify', { employeeId: w.maria, pin: p })).status).toBe(423);
  });

  it('concurrency: a floating employee cannot be double-booked from two hotels at once', async () => {
    const results = await Promise.all([
      M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.flo, shiftId: w.early, date: '2026-10-05' }),
      M2().post('/schedules', { hotelId: w.h2, entryType: 'shift', employeeId: w.flo, shiftId: w.early2, date: '2026-10-05' }),
      M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.flo, shiftId: w.mid, date: '2026-10-05' }),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await q('SELECT 1 FROM schedules WHERE employee_id = $1', [w.flo])).length).toBe(1);
  });

  it('concurrency: parallel overlapping absences — only one is stored', async () => {
    const res = await Promise.all(
      [0, 1, 2, 3].map(() => M1().post(`/employees/${w.jon}/time-offs`, { type: 'unpaid_leave', startDate: '2026-11-02', endDate: '2026-11-04' })),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(3);
    void advance; void createEmployee;
  });

  it('recorded breaks for minors follow R18: net time rule and only blocks of >= 15 minutes count', async () => {
    await patchSettings(w.h1, (st) => (st.attendance.breakMode = 'recorded'));
    const dev = await pair(w.h1, w.tokens.manager1);
    const day = async (employeeId: number, breaks: [string, string][], inAt: string, outAt: string) => {
      const p = await pin(employeeId);
      setNow(inAt);
      await punch(dev, employeeId, p, 'clock_in');
      for (const [from, to] of breaks) {
        setNow(from);
        await punch(dev, employeeId, p, 'break_start');
        setNow(to);
        await punch(dev, employeeId, p, 'break_end');
      }
      setNow(outAt);
      return (await punch(dev, employeeId, p, 'clock_out')).body.anomalies.filter((a: any) => a.type === 'missing_break');
    };
    // 17-year-old, 5 h net work: needs 30 min; one 20 min break is not enough
    expect(await day(w.mia, [['2026-10-01T08:00:00Z', '2026-10-01T08:20:00Z']], '2026-10-01T05:00:00Z', '2026-10-01T10:20:00Z')).toEqual([{ type: 'missing_break', requiredMinutes: 30, actualMinutes: 20, rule: 'minor' }]);
    await q('DELETE FROM time_entries');
    // three breaks of 10 min add up to 30 but none is a block of >= 15 min → still missing
    const tiny = await day(w.mia, [['2026-10-02T07:00:00Z', '2026-10-02T07:10:00Z'], ['2026-10-02T08:00:00Z', '2026-10-02T08:10:00Z'], ['2026-10-02T09:00:00Z', '2026-10-02T09:10:00Z']], '2026-10-02T05:00:00Z', '2026-10-02T10:30:00Z');
    expect(tiny[0]).toMatchObject({ requiredMinutes: 30, actualMinutes: 0 });
    await q('DELETE FROM time_entries');
    // one proper 35 min break is enough; an adult is judged by the adult rule on gross time (over 6 h → 30 min)
    expect(await day(w.mia, [['2026-10-03T08:00:00Z', '2026-10-03T08:35:00Z']], '2026-10-03T05:00:00Z', '2026-10-03T10:35:00Z')).toEqual([]);
    expect(await day(w.maria, [['2026-10-03T08:00:00Z', '2026-10-03T08:10:00Z']], '2026-10-03T05:00:00Z', '2026-10-03T11:30:00Z')).toEqual([{ type: 'missing_break', requiredMinutes: 30, actualMinutes: 10 }]);
  });
});
