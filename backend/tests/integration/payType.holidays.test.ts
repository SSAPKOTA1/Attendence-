import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { createEmployee, setupWorld, World } from '../helpers/fixtures';
import { closePool } from '../../src/db/pool';

let w: World;
const M1 = () => as(w.tokens.manager1);

describe('SPEC 1.8: salaried vs hourly, public holidays off per employee', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('pay type is chosen when the employee is created; holidays-off defaults to yes', async () => {
    const missing = await as(w.tokens.admin).post('/employees', { firstName: 'No', lastName: 'Type', homeHotelId: w.h1, departmentIds: [w.d1] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0].field).toBe('payType');
    const hourly = await as(w.tokens.admin).post('/employees', { firstName: 'Hana', lastName: 'Hourly', homeHotelId: w.h1, departmentIds: [w.d1], payType: 'hourly', publicHolidaysOff: false });
    expect(hourly.status).toBe(201);
    expect(hourly.body).toMatchObject({ payType: 'hourly', publicHolidaysOff: false });
    const salaried = await as(w.tokens.admin).post('/employees', { firstName: 'Sal', lastName: 'Aried', homeHotelId: w.h1, departmentIds: [w.d1], payType: 'salary' });
    expect(salaried.body).toMatchObject({ payType: 'salary', publicHolidaysOff: true });
    const changed = await M1().patch(`/employees/${hourly.body.id}`, { payType: 'salary', publicHolidaysOff: true });
    expect(changed.body).toMatchObject({ payType: 'salary', publicHolidaysOff: true });
    // pay type is pay information: not shown to managers of other hotels
    expect((await as(w.tokens.manager2).get(`/employees/${w.flo}`)).body).not.toHaveProperty('payType');
  });

  it('time account (Arbeitszeitkonto) only for salaried employees', async () => {
    await M1().patch(`/employees/${w.jon}`, { payType: 'hourly' });
    await M1().post('/attendance', { hotelId: w.h1, employeeId: w.jon, clockInAt: '2026-09-07T06:00:00Z', clockOutAt: '2026-09-07T14:00:00Z', breakMinutes: 30, reason: 'x' });
    const hourly = await M1().get(`/employees/${w.jon}/time-account?from=2026-09&to=2026-09`);
    expect(hourly.body).toMatchObject({ payType: 'hourly', timeAccountEnabled: false, balanceHours: null });
    expect(hourly.body.months[0]).toMatchObject({ month: '2026-09', workedHours: 7.5, targetHours: null, deltaHours: null });
    const salaried = await M1().get(`/employees/${w.maria}/time-account?from=2026-09&to=2026-09`);
    expect(salaried.body).toMatchObject({ payType: 'salary', timeAccountEnabled: true, balanceHours: -160 });
    const pay = await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-09&format=json`);
    expect(pay.body.data.find((r: any) => r.employeeId === w.jon)).toMatchObject({ payType: 'hourly', workedMinutes: 450, timeAccountDeltaMinutes: null });
    const dash = await as(w.tokens.jon).get('/me/dashboard');
    expect(dash.body.timeAccount).toEqual({ enabled: false, balanceHours: null });
  });

  it('vacation over a public holiday: skipped only for employees with holidays off', async () => {
    const off = await M1().post('/time-offs/preview', { employeeId: w.maria, type: 'annual_leave', startDate: '2026-12-21', endDate: '2026-12-25' });
    expect(off.body.timeOffDays).toBe(4);
    await M1().patch(`/employees/${w.jon}`, { publicHolidaysOff: false });
    const works = await M1().post('/time-offs/preview', { employeeId: w.jon, type: 'annual_leave', startDate: '2026-12-21', endDate: '2026-12-25' });
    expect(works.body.timeOffDays).toBe(5);
    expect(works.body.skipped).toEqual([]);
  });

  it('paid public holiday credit, not when the employee works that day', async () => {
    const week = '/work-summary?from=2026-12-21&to=2026-12-27';
    expect((await M1().get(`/employees/${w.maria}${week}`)).body.creditedHours).toBe(8); // 25 Dec (26 Dec is a Saturday)
    await M1().patch(`/employees/${w.jon}`, { publicHolidaysOff: false });
    expect((await M1().get(`/employees/${w.jon}${week}`)).body.creditedHours).toBe(0);
    const dec = await M1().get(`/employees/${w.maria}/time-account?from=2026-12&to=2026-12`);
    expect(dec.body.months[0].creditedHours).toBe(8);
    const s = await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-12-25' });
    expect(s.status).toBe(201);
    expect(s.body.warnings.find((x: any) => x.type === 'public_holiday_off')).toMatchObject({ severity: 'warning' });
    const after = await M1().get(`/employees/${w.maria}${week}`);
    expect(after.body).toMatchObject({ creditedHours: 0, scheduledPaidHours: 7.5 });
    const other = await createEmployee({ companyId: w.companyId, firstName: 'Holiday', lastName: 'Worker', homeHotelId: w.h1, departmentIds: [w.d1] });
    await M1().patch(`/employees/${other}`, { publicHolidaysOff: false });
    const s2 = await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: other, shiftId: w.late, date: '2026-12-25' });
    expect(s2.body.warnings.map((x: any) => x.type)).not.toContain('public_holiday_off');
  });
});
