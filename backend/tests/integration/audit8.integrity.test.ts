import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { createEmployee, setupWorld, World } from '../helpers/fixtures';
import { q } from '../helpers/db';
import { closePool } from '../../src/db/pool';
import { setNow } from '../../src/clock';

let w: World;
const M1 = () => as(w.tokens.manager1);
const ADMIN = () => as(w.tokens.admin);
const sh = (employeeId: number, shiftId: number, date: string) => ({ hotelId: w.h1, entryType: 'shift', employeeId, shiftId, date });

describe('audit 8: master-data edits cannot corrupt roster, payroll or history', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('a shift that is in use can only be renamed; unused shifts can be redesigned', async () => {
    const fresh = await ADMIN().post('/shifts', { hotelId: w.h1, departmentId: w.d1, name: 'Fresh', startTime: '09:00', endTime: '17:00', breakDurationMinutes: 30 });
    expect((await ADMIN().patch(`/shifts/${fresh.body.id}`, { startTime: '10:00', endTime: '18:00', breakDurationMinutes: 45 })).body).toMatchObject({ startTime: '10:00', paidHours: 7.25 });
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-05'));
    for (const body of [{ endTime: '16:00' }, { startTime: '05:00' }, { breakDurationMinutes: 45 }, { departmentId: w.d2 }]) {
      const res = await ADMIN().patch(`/shifts/${w.early}`, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body.error.code).toBe('RESOURCE_IN_USE');
      expect(res.body.error.details[0].entries).toBe(1);
    }
    const renamed = await ADMIN().patch(`/shifts/${w.early}`, { name: 'Frühdienst', startTime: '06:00' }); // unchanged values are fine
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Frühdienst', startTime: '06:00', endTime: '14:00' });
    // the roster still shows the same hours
    expect((await M1().get(`/schedules?hotelId=${w.h1}&from=2026-10-05&to=2026-10-05`)).body.data[0].shift).toMatchObject({ name: 'Frühdienst', paidHours: 7.5 });
  });

  it('a deleted shift keeps its history readable; future use blocks deletion', async () => {
    const s = await M1().post('/schedules', sh(w.maria, w.early, '2026-10-05'));
    expect((await ADMIN().delete(`/shifts/${w.early}`)).status).toBe(409);
    await M1().delete(`/schedules/${s.body.id}`);
    // an entry in the past (admin override) still references the shift
    const past = await ADMIN().post('/schedules', { ...sh(w.maria, w.early, '2026-09-28'), allowPast: true });
    expect(past.status).toBe(201);
    expect((await ADMIN().delete(`/shifts/${w.early}`)).status).toBe(204);
    const hist = await M1().get(`/schedules?hotelId=${w.h1}&from=2026-09-28&to=2026-09-28`);
    expect(hist.body.data[0].shift).toMatchObject({ name: 'Early', startTime: '06:00', paidHours: 7.5 });
    expect((await M1().get('/shifts?hotelId=' + w.h1)).body.data.map((x: any) => x.id)).not.toContain(w.early);
    expect((await M1().post('/schedules', sh(w.jon, w.early, '2026-10-06'))).status).toBe(404); // cannot be used any more
  });

  it('departments cannot be taken from an employee with future roster entries', async () => {
    await M1().post('/schedules', sh(w.jon, w.hk, '2026-10-05')); // jon: Front Desk + Housekeeping
    const blocked = await M1().patch(`/employees/${w.jon}`, { departmentIds: [w.d1] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('RESOURCE_IN_USE');
    expect(blocked.body.error.details[0].departmentId).toBe(w.d2);
    expect((await M1().get(`/employees/${w.jon}`)).body.departments).toHaveLength(2); // rolled back
    expect((await M1().patch(`/employees/${w.jon}`, { departmentIds: [w.d1, w.d2, w.d3] })).status).toBe(200); // adding is fine
    // after the entry is gone (or is in the past) the department can go
    setNow('2026-10-06T08:00:00Z');
    expect((await M1().patch(`/employees/${w.jon}`, { departmentIds: [w.d1] })).status).toBe(200);
    // same rule through the hotel-assignment endpoint
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-12'));
    const viaHotels = await as(w.tokens.regional).put(`/employees/${w.maria}/hotels`, { hotelIds: [w.h1], homeHotelId: w.h1, departmentIds: [] });
    expect(viaHotels.status).toBe(409);
  });

  it('work-summary week status: below / on_target / above / over_max, and credits reduce the target for unpaid leave', async () => {
    await M1().put(`/employees/${w.maria}/work-targets`, { targetHoursPerWeek: 15, minHoursPerWeek: 10, maxHoursPerWeek: 25 });
    const status = async () => (await M1().get(`/employees/${w.maria}/work-summary?from=2026-10-05&to=2026-10-11`)).body.weeks[0];
    expect((await status()).status).toBe('below');
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-05'));
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-06'));
    expect(await status()).toMatchObject({ scheduledPaidHours: 15, status: 'on_target' });
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-07'));
    expect((await status()).status).toBe('above');
    await M1().post('/schedules', sh(w.maria, w.late, '2026-10-08'));
    const over = await status();
    expect(over).toMatchObject({ scheduledPaidHours: 30, status: 'over_max' });
    const summary = await M1().get(`/employees/${w.maria}/work-summary?from=2026-10-05&to=2026-10-11`);
    expect(summary.body.warnings.map((x: any) => x.type)).toContain('exceeds_max_week');
    // unpaid leave on a work day lowers the weekly target by one working day (15 h / 5)
    await ADMIN().patch(`/employees/${w.jon}`, { workWeekdays: [1, 2, 3, 4, 5] });
    await M1().post(`/employees/${w.jon}/time-offs`, { type: 'unpaid_leave', startDate: '2026-10-09', endDate: '2026-10-09' });
    expect((await M1().get(`/employees/${w.jon}/work-summary?from=2026-10-05&to=2026-10-11`)).body.weeks[0].targetHours).toBe(32);
  });

  it('staffing requirements: validation and replacement', async () => {
    expect((await M1().put(`/shifts/${w.early}/staffing-requirements`, { requirements: [{ weekday: 1, minStaff: 1 }, { weekday: 1, minStaff: 2 }] })).status).toBe(400);
    expect((await M1().put(`/shifts/${w.early}/staffing-requirements`, { requirements: [{ weekday: 1, minStaff: -1 }] })).status).toBe(400);
    await M1().put(`/shifts/${w.early}/staffing-requirements`, { requirements: [{ weekday: 1, minStaff: 2 }, { weekday: 2, minStaff: 3 }] });
    const replaced = await M1().put(`/shifts/${w.early}/staffing-requirements`, [{ weekday: 3, minStaff: 1 }]); // bare array accepted too
    expect(replaced.body.data).toEqual([{ weekday: 3, minStaff: 1 }]);
    expect((await M1().put(`/shifts/${w.early}/staffing-requirements`, { requirements: [] })).body.data).toEqual([]);
    expect((await as(w.tokens.manager2).put(`/shifts/${w.early}/staffing-requirements`, { requirements: [] })).status).toBe(404);
  });

  it('attendance analytics counts no-shows, late and unscheduled work per employee', async () => {
    const mk = async (employeeId: number, shiftId: number, date: string) => {
      await ADMIN().post('/schedules', { ...sh(employeeId, shiftId, date), allowPast: true });
      await ADMIN().post('/schedules/publish', { hotelId: w.h1, from: date, to: date });
    };
    await mk(w.maria, w.early, '2026-09-28'); // will be a no-show
    await mk(w.jon, w.early, '2026-09-28');
    await M1().post('/attendance', { hotelId: w.h1, employeeId: w.jon, clockInAt: '2026-09-28T04:30:00Z', clockOutAt: '2026-09-28T12:00:00Z', breakMinutes: 30, reason: 'x' });
    await q(`UPDATE time_entries SET anomalies = '[{"type":"late_clock_in","minutes":30},{"type":"overtime","minutes":45}]'::jsonb`);
    await M1().post('/attendance', { hotelId: w.h1, employeeId: w.flo, clockInAt: '2026-09-29T06:00:00Z', clockOutAt: '2026-09-29T10:00:00Z', reason: 'x' });
    await q(`UPDATE time_entries SET anomalies = '[{"type":"unscheduled_work"}]'::jsonb WHERE employee_id = $1`, [w.flo]);
    const res = await M1().get(`/hotels/${w.h1}/analytics/attendance?from=2026-09-28&to=2026-09-30`);
    const by = (id: number) => res.body.byEmployee.find((e: any) => e.employeeId === id);
    expect(by(w.maria)).toMatchObject({ noShowCount: 1, plannedPaidHours: 7.5, actualPaidHours: 0 });
    expect(by(w.jon)).toMatchObject({ noShowCount: 0, lateCount: 1, overtimeHours: 0.75, actualPaidHours: 7 });
    expect(by(w.flo)).toMatchObject({ unscheduledCount: 1, actualPaidHours: 4 });
    expect(res.body.totals).toMatchObject({ noShowCount: 1, lateCount: 1, unscheduledCount: 1, actualPaidHours: 11 });
  });

  it('employee absence list filters, and staff only see their own', async () => {
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-11-02', endDate: '2026-11-02' });
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2027-01-04', endDate: '2027-01-04' });
    expect((await as(w.tokens.maria).get(`/employees/me/time-offs?year=2026`)).body.data).toHaveLength(1);
    expect((await as(w.tokens.maria).get(`/employees/me/time-offs?year=2027`)).body.data).toHaveLength(1);
    expect((await as(w.tokens.maria).get(`/employees/me/time-offs?status=pending`)).body.data).toHaveLength(0);
    expect((await as(w.tokens.maria).get(`/employees/${w.jon}/time-offs`)).status).toBe(404);
    const other = await createEmployee({ companyId: w.companyId, firstName: 'O', lastName: 'T', homeHotelId: w.h2, departmentIds: [w.d4] });
    expect((await M1().get(`/employees/${other}/time-offs`)).status).toBe(404);
  });

  it('terminating an employee: future roster entries must be removed explicitly', async () => {
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-05'));
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-06'));
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-12'));
    const refused = await M1().patch(`/employees/${w.maria}`, { status: 'terminated', terminatedOn: '2026-10-05' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('RESOURCE_IN_USE');
    expect(refused.body.error.details[0].entries).toBe(2); // the 5th itself is her last working day
    expect((await M1().get(`/employees/${w.maria}`)).body.status).toBe('active'); // rolled back
    const ok = await M1().patch(`/employees/${w.maria}`, { status: 'terminated', terminatedOn: '2026-10-05', removeFutureEntries: true });
    expect(ok.status).toBe(200);
    expect((await q('SELECT date FROM schedules WHERE employee_id = $1', [w.maria])).map((r) => r.date)).toEqual(['2026-10-05']);
    expect((await q(`SELECT meta FROM audit_logs WHERE action = 'schedule.delete' AND meta->>'cause' = 'employee_terminated'`))).toHaveLength(2);
    // terminated in the future: login stays until the date passes
    await M1().post('/schedules', sh(w.jon, w.early, '2026-10-20'));
    expect((await M1().patch(`/employees/${w.jon}`, { status: 'terminated', terminatedOn: '2026-10-31', removeFutureEntries: true })).status).toBe(200);
    expect((await q(`SELECT status FROM users WHERE id = $1`, [w.uJon]))[0].status).toBe('active');
    expect((await q('SELECT 1 FROM schedules WHERE employee_id = $1', [w.jon])).length).toBe(1);
  });

  it('anonymisation also erases the employee’s inquiries', async () => {
    const i = await as(w.tokens.jon).post('/inquiries', { subject: 'Personal', body: 'my private details' });
    await q(`UPDATE employees SET status = 'terminated', terminated_on = '2022-01-01' WHERE id = $1`, [w.jon]);
    expect((await ADMIN().post(`/employees/${w.jon}/anonymize`, {})).status).toBe(200);
    expect((await q('SELECT 1 FROM inquiries WHERE id = $1', [i.body.id])).length).toBe(0);
    expect((await q('SELECT 1 FROM inquiry_messages')).length).toBe(0);
  });
});
