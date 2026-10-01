import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { createEmployee, createUser, setupWorld, token, World } from '../helpers/fixtures';
import { q, q1 } from '../helpers/db';
import { closePool } from '../../src/db/pool';

let w: World;

async function allowance(tok: string, emp: number | string, year: number) {
  const r = await as(tok).get(`/employees/${emp}/vacation-allowance?year=${year}`);
  expect(r.status).toBe(200);
  return r.body;
}

describe('Phase 4: absences, allowance, blackouts', () => {
  beforeAll(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('#13 preview Mon–Fri with one public holiday', async () => {
    const res = await as(w.tokens.manager1).post('/time-offs/preview', { employeeId: w.maria, type: 'annual_leave', startDate: '2026-12-21', endDate: '2026-12-25' });
    expect(res.status).toBe(200);
    expect(res.body.timeOffDays).toBe(4);
    expect(res.body.skipped).toEqual([{ date: '2026-12-25', reason: 'public_holiday', name: expect.any(String) }]);
    expect(res.body.allowance).toEqual({ year: 2026, remainingBefore: 30, remainingAfter: 26 });
    expect(res.body.conflicts).toEqual({ scheduleIds: [] });
  });

  it('#14 preview with half-day flags', async () => {
    const res = await as(w.tokens.maria).post('/time-offs/preview', { employeeId: 'me', type: 'annual_leave', startDate: '2026-10-12', endDate: '2026-10-16', startHalfDay: true, endHalfDay: true });
    expect(res.status).toBe(200);
    expect(res.body.days[0]).toEqual({ date: '2026-10-12', fraction: 0.5 });
    expect(res.body.days[4]).toEqual({ date: '2026-10-16', fraction: 0.5 });
    expect(res.body.timeOffDays).toBe(4);
    const single = await as(w.tokens.maria).post('/time-offs/preview', { employeeId: 'me', type: 'annual_leave', startDate: '2026-10-12', endDate: '2026-10-12', startHalfDay: true, endHalfDay: true });
    expect(single.status).toBe(400);
  });

  it('#15 annual leave 28 Dec–3 Jan: usage split across both years', async () => {
    const emp = await createEmployee({ companyId: w.companyId, firstName: 'Seven', lastName: 'Days', homeHotelId: w.h1, departmentIds: [w.d1], workWeekdays: [1, 2, 3, 4, 5, 6, 7] });
    const res = await as(w.tokens.manager1).post(`/employees/${emp}/time-offs`, { type: 'annual_leave', startDate: '2026-12-28', endDate: '2027-01-03' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('approved');
    expect(res.body.timeOffDays).toBe(6); // 28–31 Dec, 2–3 Jan; 1 Jan is a holiday
    expect((await allowance(w.tokens.manager1, emp, 2026)).usedDays).toBe(4);
    expect((await allowance(w.tokens.manager1, emp, 2027)).usedDays).toBe(2);
  });

  it('#16 annual leave needing more than remaining → 422 ALLOWANCE_EXCEEDED', async () => {
    const res = await as(w.tokens.manager1).post(`/employees/${w.jon}/time-offs`, { type: 'annual_leave', startDate: '2026-11-02', endDate: '2026-12-18' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ALLOWANCE_EXCEEDED');
    expect(res.body.error.details[0]).toMatchObject({ year: 2026, requested: 35, available: 30 });
  });

  it('#17 overlapping annual leave and unpaid leave → 409 TIME_OFF_OVERLAP', async () => {
    expect((await as(w.tokens.manager1).post(`/employees/${w.jon}/time-offs`, { type: 'annual_leave', startDate: '2026-11-02', endDate: '2026-11-06', status: 'pending' })).status).toBe(201);
    const res = await as(w.tokens.manager1).post(`/employees/${w.jon}/time-offs`, { type: 'unpaid_leave', startDate: '2026-11-05', endDate: '2026-11-10' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TIME_OFF_OVERLAP');
  });

  it('#18 sick leave inside approved vacation; certificate refunds vacation', async () => {
    const vac = await as(w.tokens.manager1).post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-11-09', endDate: '2026-11-13' });
    expect(vac.status).toBe(201);
    const before = await allowance(w.tokens.maria, 'me', 2026);
    const sick = await as(w.tokens.manager1).post(`/employees/${w.maria}/time-offs`, { type: 'sick_leave', startDate: '2026-11-11', endDate: '2026-11-12' });
    expect(sick.status).toBe(201);
    expect((await allowance(w.tokens.maria, 'me', 2026)).usedDays).toBe(before.usedDays);
    const cert = await as(w.tokens.manager1).patch(`/time-offs/${sick.body.id}`, { medicalCertificateReceived: true });
    expect(cert.status).toBe(200);
    expect((await allowance(w.tokens.maria, 'me', 2026)).usedDays).toBe(before.usedDays - 2);
  });

  it('#19 sick leave with a reason → 400', async () => {
    const res = await as(w.tokens.maria).post(`/employees/me/time-offs`, { type: 'sick_leave', startDate: '2026-10-05', endDate: '2026-10-06', reason: 'flu' });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('reason');
  });

  it('#20 sick leave over roster entries: accepted with conflicts; unassignConflicts removes them', async () => {
    const s1 = await as(w.tokens.manager1).post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.jon, shiftId: w.early, date: '2026-10-07' });
    expect(s1.status).toBe(201);
    const keep = await as(w.tokens.manager1).post(`/employees/${w.jon}/time-offs`, { type: 'sick_leave', startDate: '2026-10-07', endDate: '2026-10-07' });
    expect(keep.status).toBe(201);
    expect(keep.body.conflicts).toEqual([s1.body.id]);
    expect(await q('SELECT 1 FROM schedules WHERE id = $1', [s1.body.id])).toHaveLength(1);
    const s2 = await as(w.tokens.manager1).post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.late, date: '2026-10-08' });
    expect(s2.status).toBe(201);
    const removed = await as(w.tokens.manager1).post(`/employees/${w.maria}/time-offs`, { type: 'sick_leave', startDate: '2026-10-08', endDate: '2026-10-08', unassignConflicts: true });
    expect(removed.status).toBe(201);
    expect(removed.body.conflicts).toEqual([s2.body.id]);
    expect(await q('SELECT 1 FROM schedules WHERE id = $1', [s2.body.id])).toHaveLength(0);
    const vacation = await as(w.tokens.manager1).post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.late, date: '2026-10-09' });
    const refused = await as(w.tokens.manager1).post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-10-09', endDate: '2026-10-09' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TIME_OFF_CONFLICTS_WITH_SCHEDULE');
    expect(refused.body.error.details[0]).toMatchObject({ scheduleId: vacation.body.id, hotelName: 'Trip Inn Frankfurt' });
  });

  it('#21 approve annual leave then cancel: usedDays up then back', async () => {
    const base = await allowance(w.tokens.manager1, w.flo, 2026);
    const req = await as(w.tokens.flo).post('/employees/me/time-offs', { type: 'annual_leave', startDate: '2026-11-16', endDate: '2026-11-20', reason: 'Autumn break' });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('pending');
    expect((await allowance(w.tokens.manager1, w.flo, 2026)).pendingDays).toBe(base.pendingDays + 5);
    const approved = await as(w.tokens.manager1).patch(`/time-offs/${req.body.id}`, { status: 'approved' });
    expect(approved.status).toBe(200);
    expect((await allowance(w.tokens.manager1, w.flo, 2026)).usedDays).toBe(base.usedDays + 5);
    const cancelled = await as(w.tokens.manager1).patch(`/time-offs/${req.body.id}`, { status: 'cancelled' });
    expect(cancelled.status).toBe(200);
    expect((await allowance(w.tokens.manager1, w.flo, 2026)).usedDays).toBe(base.usedDays);
    const again = await as(w.tokens.manager1).patch(`/time-offs/${req.body.id}`, { status: 'approved' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    // the floating employee's absence is decided by the home hotel only
    const req2 = await as(w.tokens.flo).post('/employees/me/time-offs', { type: 'annual_leave', startDate: '2026-11-23', endDate: '2026-11-24' });
    expect((await as(w.tokens.manager2).patch(`/time-offs/${req2.body.id}`, { status: 'approved' })).status).toBe(404);
  });

  it('#22 staff cancels own pending / another employee’s request', async () => {
    const own = await as(w.tokens.maria).post('/employees/me/time-offs', { type: 'unpaid_leave', startDate: '2026-12-01', endDate: '2026-12-01' });
    expect(own.status).toBe(201);
    const cancel = await as(w.tokens.maria).patch(`/time-offs/${own.body.id}`, { status: 'cancelled' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('cancelled');
    const other = await as(w.tokens.flo).post('/employees/me/time-offs', { type: 'unpaid_leave', startDate: '2026-12-02', endDate: '2026-12-02' });
    const foreign = await as(w.tokens.maria).patch(`/time-offs/${other.body.id}`, { status: 'cancelled' });
    expect(foreign.status).toBe(404);
    const approveOwn = await as(w.tokens.flo).patch(`/time-offs/${other.body.id}`, { status: 'approved' });
    expect(approveOwn.status).toBe(403);
    expect((await as(w.tokens.maria).post('/employees/me/time-offs', { type: 'school', startDate: '2026-12-03', endDate: '2026-12-03' })).status).toBe(403);
  });

  it('#94 allowance of a 16-year-old below the statutory minimum', async () => {
    const emp = await createEmployee({ companyId: w.companyId, firstName: 'Teen', lastName: 'Ager', homeHotelId: w.h1, departmentIds: [w.d1], birthDate: '2010-06-01', employmentType: 'apprentice' });
    const res = await as(w.tokens.manager1).put(`/employees/${emp}/vacation-allowance`, { year: 2027, vacationDaysPerYear: 20 });
    expect(res.status).toBe(200);
    expect(res.body.warnings[0]).toMatchObject({ type: 'below_statutory_minimum', minimumDays: 23 });
    const ok = await as(w.tokens.manager1).put(`/employees/${emp}/vacation-allowance`, { year: 2027, vacationDaysPerYear: 25 });
    expect(ok.body.warnings).toEqual([]);
  });

  it('#113 leave over a warn / block blackout', async () => {
    const warn = await as(w.tokens.manager1).post('/leave-blackouts', { hotelId: w.h1, startDate: '2027-03-01', endDate: '2027-03-05', reason: 'Trade fair', mode: 'warn' });
    expect(warn.status).toBe(201);
    const block = await as(w.tokens.manager1).post('/leave-blackouts', { hotelId: w.h1, startDate: '2027-04-05', endDate: '2027-04-09', reason: 'Musikmesse', mode: 'block' });
    expect(block.status).toBe(201);
    const r1 = await as(w.tokens.maria).post('/employees/me/time-offs', { type: 'annual_leave', startDate: '2027-03-02', endDate: '2027-03-03' });
    expect(r1.status).toBe(201);
    expect(r1.body.warnings[0]).toMatchObject({ type: 'leave_blackout', mode: 'warn', reason: 'Trade fair' });
    const r2 = await as(w.tokens.maria).post('/employees/me/time-offs', { type: 'annual_leave', startDate: '2027-04-06', endDate: '2027-04-07' });
    expect(r2.status).toBe(422);
    expect(r2.body.error.code).toBe('LEAVE_BLACKOUT');
    const noReason = await as(w.tokens.manager1).post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2027-04-06', endDate: '2027-04-07' });
    expect(noReason.status).toBe(422);
    const r3 = await as(w.tokens.manager1).post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2027-04-06', endDate: '2027-04-07', overrideReason: 'Wedding, agreed' });
    expect(r3.status).toBe(201);
    const sick = await as(w.tokens.maria).post('/employees/me/time-offs', { type: 'sick_leave', startDate: '2027-04-08', endDate: '2027-04-08' });
    expect(sick.status).toBe(201);
    const audit = await q1(`SELECT meta FROM audit_logs WHERE action = 'time_off.create' AND entity_id = $1`, [r3.body.id]);
    expect(audit.meta.overrideReason).toBe('Wedding, agreed');
    const list = await as(w.tokens.maria).get(`/leave-blackouts?year=2027`);
    expect(list.body.data).toHaveLength(2);
  });

  it('#115 floating employee: holidays of the home hotel region', async () => {
    const res = await as(w.tokens.flo).post('/time-offs/preview', { employeeId: 'me', type: 'annual_leave', startDate: '2027-01-04', endDate: '2027-01-08' });
    expect(res.status).toBe(200);
    expect(res.body.timeOffDays).toBe(5); // 6 Jan is a holiday in Bavaria (hotel 2) only
    const home2 = await createEmployee({ companyId: w.companyId, firstName: 'Bavarian', lastName: 'Home', homeHotelId: w.h2, otherHotelIds: [w.h1], departmentIds: [w.d4] });
    const r2 = await as(w.tokens.regional).post('/time-offs/preview', { employeeId: home2, type: 'annual_leave', startDate: '2027-01-04', endDate: '2027-01-08' });
    expect(r2.body.timeOffDays).toBe(4);
  });

  it('#70 (absence part) other hotel manager sees only "unavailable"', async () => {
    const vac = await as(w.tokens.manager1).post(`/employees/${w.flo}/time-offs`, { type: 'annual_leave', startDate: '2026-10-19', endDate: '2026-10-20' });
    expect(vac.status).toBe(201);
    const list = await as(w.tokens.manager2).get(`/time-offs?hotelId=${w.h2}&from=2026-10-01&to=2026-10-31`);
    expect(list.status).toBe(200);
    const row = list.body.data.find((r: any) => r.employeeId === w.flo && r.startDate === '2026-10-19');
    expect(row).toEqual({ employeeId: w.flo, startDate: '2026-10-19', endDate: '2026-10-20', status: 'unavailable' });
    expect((await as(w.tokens.manager2).get(`/time-offs/${vac.body.id}`)).status).toBe(404);
    const home = await as(w.tokens.manager1).get(`/time-offs?hotelId=${w.h1}&from=2026-10-01&to=2026-10-31`);
    expect(home.body.data.find((r: any) => r.id === vac.body.id).type).toBe('annual_leave');
  });

  it('NO_WORKING_DAYS_IN_RANGE and staff-only own requests', async () => {
    const res = await as(w.tokens.maria).post('/employees/me/time-offs', { type: 'annual_leave', startDate: '2026-10-10', endDate: '2026-10-11' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_WORKING_DAYS_IN_RANGE');
    expect((await as(w.tokens.maria).post(`/employees/${w.jon}/time-offs`, { type: 'annual_leave', startDate: '2026-10-12', endDate: '2026-10-12' })).status).toBe(404);
    const u = await createUser({ companyId: w.companyId, role: 'manager', email: 'x2@tripinn.test', hotelIds: [w.h2] });
    expect((await as(await token(u)).post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-10-12', endDate: '2026-10-12' })).status).toBe(404);
  });
});
