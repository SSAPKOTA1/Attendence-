import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { patchSettings, setupWorld, World } from '../helpers/fixtures';
import { closePool } from '../../src/db/pool';

let w: World;
const M1 = () => as(w.tokens.manager1);

describe('Phase 7: wishes and planning dashboard', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('#57 shift wish on a scheduled date → 409; on an approved absence → 422', async () => {
    await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-10-05' });
    const a = await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-10-05', shiftId: w.late, kind: 'prefer' });
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('EMPLOYEE_ALREADY_SCHEDULED');
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-10-06', endDate: '2026-10-06' });
    const b = await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-10-06', shiftId: w.late, kind: 'prefer' });
    expect(b.status).toBe(422);
    expect(b.body.error.code).toBe('EMPLOYEE_ON_TIME_OFF');
    const past = await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-09-30', shiftId: w.late, kind: 'prefer' });
    expect(past.status).toBe(422);
    const preferWithoutShift = await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-10-07', kind: 'prefer' });
    expect(preferWithoutShift.status).toBe(400);
  });

  it('#58 day-off wish, then assigning a shift that day → conflicts_with_wish', async () => {
    const wish = await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-10-08', kind: 'avoid', priority: 1, reason: 'Family' });
    expect(wish.status).toBe(201);
    expect(wish.body).toMatchObject({ shiftId: null, kind: 'avoid', status: 'pending', hotelId: w.h1 });
    const dup = await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-10-08', kind: 'avoid' });
    expect(dup.status).toBe(409);
    const res = await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-10-08' });
    expect(res.status).toBe(201);
    expect(res.body.warnings.find((x: any) => x.type === 'conflicts_with_wish')).toMatchObject({ severity: 'info', wishId: wish.body.id });
  });

  it('#59 staff cannot approve their own wish; manager decides; wishId links on assignment', async () => {
    const wish = await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-10-09', shiftId: w.early, kind: 'prefer' });
    const own = await as(w.tokens.maria).patch(`/shift-wishes/${wish.body.id}`, { status: 'approved' });
    expect(own.status).toBe(403);
    const assigned = await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-10-09', wishId: wish.body.id });
    expect(assigned.status).toBe(201);
    const list = await as(w.tokens.maria).get('/shift-wishes');
    expect(list.body.data[0]).toMatchObject({ status: 'approved', fulfilledScheduleId: assigned.body.id });
    const w2 = await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-10-12', shiftId: w.late, kind: 'prefer' });
    expect((await as(w.tokens.maria).patch(`/shift-wishes/${w2.body.id}`, { status: 'cancelled' })).body.status).toBe('cancelled');
    const w3 = await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-10-13', shiftId: w.late, kind: 'prefer' });
    const decided = await M1().patch(`/shift-wishes/${w3.body.id}`, { status: 'rejected', decisionNote: 'Fully staffed' });
    expect(decided.body).toMatchObject({ status: 'rejected', decisionNote: 'Fully staffed' });
  });

  it('#60 planning dashboard without staffing requirements → coverageRisk null', async () => {
    const lw = await as(w.tokens.maria).post('/employees/me/leave-wishes', { startDate: '2026-11-02', endDate: '2026-11-06', priority: 1, reason: 'Trip' });
    expect(lw.status).toBe(201);
    expect(lw.body.leaveDays).toBe(5);
    await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-11-09', kind: 'avoid' });
    const dash = await M1().get(`/hotels/${w.h1}/planning-dashboard?from=2026-10-01&to=2026-11-30`);
    expect(dash.status).toBe(200);
    expect(dash.body.leaveWishes[0]).toMatchObject({ id: lw.body.id, coverageRisk: null, employee: { displayName: 'Maria G.' } });
    expect(dash.body.summary).toEqual({ pendingShiftWishes: 1, pendingLeaveWishes: 1 });
    await M1().put(`/shifts/${w.early}/staffing-requirements`, { requirements: [{ weekday: 1, minStaff: 1 }] });
    const dash2 = await M1().get(`/hotels/${w.h1}/planning-dashboard?from=2026-10-01&to=2026-11-30`);
    expect(dash2.body.leaveWishes[0].coverageRisk).toEqual({ level: 'low', understaffedDates: ['2026-11-02'] });
    const overlap = await as(w.tokens.maria).post('/employees/me/leave-wishes', { startDate: '2026-11-05', endDate: '2026-11-10' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('TIME_OFF_OVERLAP');
    const timeOff = await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-11-02', endDate: '2026-11-06', leaveWishId: lw.body.id });
    expect(timeOff.status).toBe(201);
    const lws = await as(w.tokens.maria).get('/leave-wishes');
    expect(lws.body.data[0]).toMatchObject({ status: 'approved', fulfilledTimeOffId: timeOff.body.id });
  });

  it('#114 staff wish inside minLeadDays → 422; manager on behalf → 201', async () => {
    await patchSettings(w.h1, (s) => (s.wishes.minLeadDays = 14));
    const res = await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-10-10', kind: 'avoid' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WISH_DEADLINE_PASSED');
    const far = await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-10-20', kind: 'avoid' });
    expect(far.status).toBe(201);
    const mgr = await M1().post(`/employees/${w.maria}/shift-wishes`, { date: '2026-10-10', kind: 'avoid', reason: 'phoned in' });
    expect(mgr.status).toBe(201);
    const leave = await as(w.tokens.maria).post('/employees/me/leave-wishes', { startDate: '2026-10-05', endDate: '2026-10-06' });
    expect(leave.status).toBe(422);
  });
});
