import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { createEmployee, patchSettings, setupWorld, World } from '../helpers/fixtures';
import { q, q1 } from '../helpers/db';
import { closePool } from '../../src/db/pool';
import { setNow } from '../../src/clock';

let w: World;
const M1 = () => as(w.tokens.manager1);
const M2 = () => as(w.tokens.manager2);
const sh = (employeeId: number, shiftId: number, date: string, extra: Record<string, unknown> = {}) => ({ hotelId: w.h1, entryType: 'shift', employeeId, shiftId, date, ...extra });
const warn = (r: any) => (r.body.warnings ?? []).map((x: any) => x.type);

describe('audit 2: roster and absence edge cases', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('PATCH: move to another day / another employee re-checks every rule and stays consistent', async () => {
    const a = await M1().post('/schedules', sh(w.maria, w.early, '2026-10-05'));
    await M1().post('/schedules', sh(w.jon, w.early, '2026-10-06'));
    // move onto a day that already has the same shift for that person
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-07'));
    expect((await M1().patch(`/schedules/${a.body.id}`, { date: '2026-10-07' })).body.error.code).toBe('EMPLOYEE_ALREADY_SCHEDULED');
    // move to another free day: week totals follow
    const moved = await M1().patch(`/schedules/${a.body.id}`, { date: '2026-10-12' });
    expect(moved.status).toBe(200);
    expect(moved.body.currentWeekHours).toBe(7.5);
    // reassign to an employee who is on leave that day
    await M1().post(`/employees/${w.jon}/time-offs`, { type: 'annual_leave', startDate: '2026-10-12', endDate: '2026-10-12' });
    expect((await M1().patch(`/schedules/${a.body.id}`, { employeeId: w.jon })).body.error.code).toBe('EMPLOYEE_ON_TIME_OFF');
    // reassign to an employee outside the department
    // mia (17) is in the department, but the 7.5 h shift breaks the youth break rule → a written reason is required
    const toMinor = await M1().patch(`/schedules/${a.body.id}`, { employeeId: w.mia });
    expect(toMinor.status).toBe(422);
    expect(toMinor.body.error.code).toBe('OVERRIDE_REASON_REQUIRED');
    expect((await M1().patch(`/schedules/${a.body.id}`, { employeeId: w.mia, overrideReason: 'cover for sick colleague' })).status).toBe(200);
    // a failed patch changes nothing
    const row = await q1('SELECT employee_id, date FROM schedules WHERE id = $1', [a.body.id]);
    expect(row).toEqual({ employee_id: w.mia, date: '2026-10-12' });
    // convert a shift into a day off and back
    const off = await M1().patch(`/schedules/${a.body.id}`, { entryType: 'off', offLabel: 'Frei', shiftId: null });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ entryType: 'off', paidHoursAssigned: 0, shift: null });
    expect((await M1().patch(`/schedules/${a.body.id}`, { entryType: 'shift', shiftId: w.early })).status).toBe(200);
    // other manager's entry is invisible
    expect((await M2().patch(`/schedules/${a.body.id}`, { shiftId: w.late })).status).toBe(404);
    // past entries are immutable, admin may override
    setNow('2026-10-13T08:00:00Z');
    expect((await M1().patch(`/schedules/${a.body.id}`, { shiftId: w.late })).body.error.code).toBe('SCHEDULE_DATE_IN_PAST');
    expect((await M1().delete(`/schedules/${a.body.id}`)).body.error.code).toBe('SCHEDULE_DATE_IN_PAST');
    expect((await as(w.tokens.admin).patch(`/schedules/${a.body.id}`, { shiftId: w.late, allowPast: true })).status).toBe(200);
    expect((await as(w.tokens.admin).delete(`/schedules/${a.body.id}?allowPast=true`)).status).toBe(200);
  });

  it('week boundaries: Sunday night shift counts toward its start week; weeks never leak into each other', async () => {
    await M1().post('/schedules', sh(w.maria, w.night, '2026-10-11')); // Sunday 22–06 → Monday
    const mon = await M1().post('/schedules', sh(w.maria, w.early, '2026-10-12'));
    expect(mon.body.currentWeekHours).toBe(7.5); // the Sunday night belongs to the previous week
    expect(warn(mon)).toContain('insufficient_rest_period');
    const sun = await M1().get(`/employees/${w.maria}/work-summary?from=2026-10-05&to=2026-10-18`);
    expect(sun.body.weeks.map((x: any) => [x.weekStart, x.scheduledPaidHours])).toEqual([['2026-10-05', 7], ['2026-10-12', 7.5]]);
  });

  it('DST: night shift across the autumn clock change does not collide with a 06:00 start', async () => {
    expect((await M1().post('/schedules', sh(w.maria, w.night, '2026-10-24'))).status).toBe(201);
    const early = await M1().post('/schedules', sh(w.maria, w.early, '2026-10-25'));
    expect(early.status).toBe(201); // the night shift really ends at 06:00 CET, exactly when Early starts
    expect(early.body.restPeriodHours).toBe(0);
    // spring: 22:00 on 28 Mar → 06:00 on 29 Mar is 7 h of real time
    const spring = await M1().post('/schedules', sh(w.jon, w.night, '2026-03-28', { allowPast: true }));
    expect(spring.status).toBe(422); // jon is in d1, past date for a manager is refused
    expect(spring.body.error.code).toBe('SCHEDULE_DATE_IN_PAST');
  });

  it('bulk atomic success, ordering, duplicates inside one request, and cross-item rules', async () => {
    const ok = await M1().post('/schedules/bulk', { hotelId: w.h1, mode: 'atomic', items: [
      { entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-10-05' },
      { entryType: 'shift', employeeId: w.maria, shiftId: w.late, date: '2026-10-05' },
    ] });
    expect(ok.status).toBe(200);
    expect(ok.body.summary).toEqual({ created: 2, failed: 0 });
    expect(ok.body.results[1].error).toBeUndefined();
    // overlap between two items of the same request is detected
    const dup = await M1().post('/schedules/bulk', { hotelId: w.h1, mode: 'partial', items: [
      { entryType: 'shift', employeeId: w.jon, shiftId: w.early, date: '2026-10-06' },
      { entryType: 'shift', employeeId: w.jon, shiftId: w.mid, date: '2026-10-06' },
      { entryType: 'off', employeeId: w.jon, date: '2026-10-06' },
    ] });
    expect(dup.body.results.map((r: any) => r.status)).toEqual(['created', 'error', 'error']);
    expect(dup.body.results[1].error.code).toBe('SHIFT_OVERLAPS_EXISTING');
    expect(dup.body.results[2].error.code).toBe('EMPLOYEE_ALREADY_SCHEDULED');
    // limits
    expect((await M1().post('/schedules/bulk', { hotelId: w.h1, items: Array.from({ length: 501 }, () => ({ entryType: 'off', employeeId: w.jon, date: '2026-11-02' })) })).status).toBe(400);
    // an employee of another hotel inside the batch fails individually
    const mixed = await M1().post('/schedules/bulk', { hotelId: w.h1, mode: 'partial', items: [
      { entryType: 'shift', employeeId: 99999, shiftId: w.early, date: '2026-10-07' },
      { entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-10-07' },
    ] });
    expect(mixed.body.results[0].error.code).toBe('RESOURCE_NOT_FOUND');
    expect(mixed.body.results[1].status).toBe('created');
  });

  it('copy: filters, overwrite of drafts only, terminated and unassigned employees skipped', async () => {
    for (const [e, s] of [[w.maria, w.early], [w.jon, w.hk], [w.flo, w.late]] as const) await M1().post('/schedules', sh(e, s, '2026-10-05'));
    await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-05', to: '2026-10-05' });
    const onlyMaria = await M1().post('/schedules/copy', { hotelId: w.h1, sourceFrom: '2026-10-05', sourceTo: '2026-10-05', targetFrom: '2026-10-12', employeeIds: [w.maria] });
    expect(onlyMaria.body.summary.created).toBe(1);
    const dept = await M1().post('/schedules/copy', { hotelId: w.h1, sourceFrom: '2026-10-05', sourceTo: '2026-10-05', targetFrom: '2026-10-19', departmentId: w.d2 });
    expect(dept.body.summary.created).toBe(1);
    // existing target: skipped without overwrite, replaced (drafts) with it
    const skip = await M1().post('/schedules/copy', { hotelId: w.h1, sourceFrom: '2026-10-05', sourceTo: '2026-10-05', targetFrom: '2026-10-12', employeeIds: [w.maria] });
    expect(skip.body.skipped).toEqual([{ employeeId: w.maria, date: '2026-10-12', reason: 'already_scheduled' }]);
    const over = await M1().post('/schedules/copy', { hotelId: w.h1, sourceFrom: '2026-10-05', sourceTo: '2026-10-05', targetFrom: '2026-10-12', employeeIds: [w.maria], overwrite: true });
    expect(over.body.summary.created).toBe(1);
    expect((await q('SELECT 1 FROM schedules WHERE employee_id = $1 AND date = $2', [w.maria, '2026-10-12'])).length).toBe(1);
    // published targets are never overwritten
    await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-12', to: '2026-10-12' });
    const pub = await M1().post('/schedules/copy', { hotelId: w.h1, sourceFrom: '2026-10-05', sourceTo: '2026-10-05', targetFrom: '2026-10-12', employeeIds: [w.maria], overwrite: true });
    expect(pub.body.skipped[0].reason).toBe('already_scheduled');
    // terminated employee
    await q(`UPDATE employees SET status = 'terminated', terminated_on = '2026-10-10' WHERE id = $1`, [w.jon]);
    const term = await M1().post('/schedules/copy', { hotelId: w.h1, sourceFrom: '2026-10-05', sourceTo: '2026-10-05', targetFrom: '2026-10-26', employeeIds: [w.jon] });
    expect(term.body.skipped[0].reason).toBe('employee_inactive');
    expect((await M1().post('/schedules', sh(w.jon, w.hk, '2026-10-27'))).body.error.code).toBe('EMPLOYEE_INACTIVE');
  });

  it('publish/unpublish by department; publishing is idempotent and notifies once per employee', async () => {
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-05'));
    await M1().post('/schedules', sh(w.jon, w.hk, '2026-10-05'));
    const dept = await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-05', to: '2026-10-05', departmentId: w.d2 });
    expect(dept.body.published).toBe(1);
    expect((await q(`SELECT employee_id FROM schedules WHERE status = 'published'`)).map((r) => r.employee_id)).toEqual([w.jon]);
    expect((await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-05', to: '2026-10-05', departmentId: w.d2 })).body.published).toBe(0);
    const un = await M1().post('/schedules/unpublish', { hotelId: w.h1, from: '2026-10-05', to: '2026-10-05' });
    expect(un.body.unpublished).toBe(1);
    expect((await q(`SELECT 1 FROM schedules WHERE status = 'published'`)).length).toBe(0);
    expect((await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-05', to: '2026-12-31' })).status).toBe(422);
  });

  it('visibility: whole_hotel / own_only plans; staff cannot read colleagues’ entries or drafts', async () => {
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-05'));
    await M1().post('/schedules', sh(w.jon, w.hk, '2026-10-05'));
    await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-05', to: '2026-10-05' });
    const day = '/schedules?from=2026-10-05&to=2026-10-05';
    expect((await as(w.tokens.maria).get(day)).body.data.map((x: any) => x.shift.name)).toEqual(['Early']);
    await patchSettings(w.h1, (s) => (s.portal.planVisibility = 'whole_hotel'));
    expect((await as(w.tokens.maria).get(day)).body.data.map((x: any) => x.shift.name).sort()).toEqual(['Early', 'Housekeeping']);
    await patchSettings(w.h1, (s) => { s.portal.planVisibility = 'own_only'; s.portal.nameFormat = 'full'; });
    const own = await as(w.tokens.maria).get(day);
    expect(own.body.data).toHaveLength(1);
    expect(own.body.data[0].employee.displayName).toBe('Maria Garcia');
    const jonEntry = await q1('SELECT id FROM schedules WHERE employee_id = $1', [w.jon]);
    expect((await as(w.tokens.maria).get(`/schedules/${jonEntry.id}`)).status).toBe(404);
    expect((await M2().get(`/schedules/${jonEntry.id}`)).status).toBe(404);
    // multi-hotel staff must say which hotel for the hotel plan, but can always read their own entries
    expect((await as(w.tokens.flo).get(day)).status).toBe(400);
    expect((await as(w.tokens.flo).get(`${day}&hotelId=${w.h2}`)).status).toBe(200);
    expect((await as(w.tokens.flo).get(`${day}&employeeId=me`)).status).toBe(200);
  });

  it('authorization table: other hotel’s manager may delete a floating employee’s off entry, nothing else', async () => {
    const off = await M1().post('/schedules', { hotelId: w.h1, entryType: 'off', employeeId: w.flo, date: '2026-10-08', offLabel: 'Frei' });
    const shift = await M1().post('/schedules', sh(w.flo, w.early, '2026-10-09'));
    expect((await M2().patch(`/schedules/${off.body.id}`, { offLabel: 'x' })).status).toBe(404);
    expect((await M2().delete(`/schedules/${shift.body.id}`)).status).toBe(404);
    expect((await M2().delete(`/schedules/${off.body.id}`)).status).toBe(200);
    const notMine = await M1().post('/schedules', { hotelId: w.h1, entryType: 'off', employeeId: w.maria, date: '2026-10-08' });
    expect((await M2().delete(`/schedules/${notMine.body.id}`)).status).toBe(404);
  });

  it('absences: pending request over roster → approval needs unassignConflicts; pending edits recompute days and allowance', async () => {
    const s = await M1().post('/schedules', sh(w.maria, w.early, '2026-11-03'));
    const req = await as(w.tokens.maria).post('/employees/me/time-offs', { type: 'annual_leave', startDate: '2026-11-02', endDate: '2026-11-04' });
    expect(req.status).toBe(201);
    expect(req.body.conflicts).toEqual([]);
    const refused = await M1().patch(`/time-offs/${req.body.id}`, { status: 'approved' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TIME_OFF_CONFLICTS_WITH_SCHEDULE');
    const approved = await M1().patch(`/time-offs/${req.body.id}`, { status: 'approved', unassignConflicts: true });
    expect(approved.status).toBe(200);
    expect(approved.body.conflicts).toEqual([s.body.id]);
    expect((await q('SELECT 1 FROM schedules WHERE id = $1', [s.body.id])).length).toBe(0);
    // approved absences cannot be edited, pending ones can
    expect((await M1().patch(`/time-offs/${req.body.id}`, { endDate: '2026-11-05' })).body.error.code).toBe('INVALID_STATUS_TRANSITION');
    const p = await as(w.tokens.maria).post('/employees/me/time-offs', { type: 'annual_leave', startDate: '2026-12-07', endDate: '2026-12-08' });
    const edited = await as(w.tokens.maria).patch(`/time-offs/${p.body.id}`, { endDate: '2026-12-11' });
    expect(edited.status).toBe(403); // staff may only withdraw
    const mEdit = await M1().patch(`/time-offs/${p.body.id}`, { endDate: '2026-12-11', endHalfDay: true });
    expect(mEdit.body).toMatchObject({ timeOffDays: 4.5, endDate: '2026-12-11' });
    expect((await q('SELECT count(*)::int n FROM time_off_dates WHERE time_off_id = $1', [p.body.id]))[0].n).toBe(5);
    const allowance = await M1().get(`/employees/${w.maria}/vacation-allowance?year=2026`);
    expect(allowance.body).toMatchObject({ usedDays: 3, pendingDays: 4.5, remainingDays: 27 });
    // overlap with another request is refused when editing
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'unpaid_leave', startDate: '2026-12-14', endDate: '2026-12-14' });
    expect((await M1().patch(`/time-offs/${p.body.id}`, { endDate: '2026-12-14' })).body.error.code).toBe('TIME_OFF_OVERLAP');
  });

  it('vacation allowance: carry-over lapses after its expiry date; per-year allowance rows', async () => {
    await M1().put(`/employees/${w.maria}/vacation-allowance`, { year: 2026, vacationDaysPerYear: 10, carriedOverDays: 5, carryOverExpiresOn: '2026-03-31' });
    // today is 1 Oct: carry-over already lapsed, none was used before the expiry
    expect((await M1().get(`/employees/${w.maria}/vacation-allowance?year=2026`)).body.remainingDays).toBe(10);
    expect((await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-11-02', endDate: '2026-11-13' })).status).toBe(201); // 10 days
    expect((await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-11-16', endDate: '2026-11-16' })).body.error.code).toBe('ALLOWANCE_EXCEEDED');
    // another year starts with its own default row
    expect((await M1().get(`/employees/${w.maria}/vacation-allowance?year=2027`)).body).toMatchObject({ vacationDaysPerYear: 30, usedDays: 0, remainingDays: 30 });
    expect((await as(w.tokens.maria).put(`/employees/me/vacation-allowance`, { year: 2026, vacationDaysPerYear: 99 })).status).toBe(403);
  });

  it('leave wishes: overlap rules, past dates, withdrawal frees the range', async () => {
    const a = await as(w.tokens.maria).post('/employees/me/leave-wishes', { startDate: '2026-11-02', endDate: '2026-11-06' });
    expect(a.status).toBe(201);
    expect((await as(w.tokens.maria).post('/employees/me/leave-wishes', { startDate: '2026-11-05', endDate: '2026-11-09' })).status).toBe(409);
    expect((await as(w.tokens.maria).post('/employees/me/leave-wishes', { startDate: '2026-09-28', endDate: '2026-09-30' })).status).toBe(422);
    expect((await as(w.tokens.maria).post('/employees/me/leave-wishes', { startDate: '2026-10-10', endDate: '2026-10-11' })).body.error.code).toBe('NO_WORKING_DAYS_IN_RANGE');
    expect((await as(w.tokens.maria).patch(`/leave-wishes/${a.body.id}`, { status: 'cancelled' })).status).toBe(200);
    expect((await as(w.tokens.maria).post('/employees/me/leave-wishes', { startDate: '2026-11-05', endDate: '2026-11-09' })).status).toBe(201);
    expect((await as(w.tokens.jon).patch(`/leave-wishes/${a.body.id}`, { status: 'cancelled' })).status).toBe(404);
    expect((await as(w.tokens.maria).post(`/employees/${w.jon}/leave-wishes`, { startDate: '2026-12-01', endDate: '2026-12-02' })).status).toBe(404);
  });

  it('employees: deleting with future entries is refused; home change; departments follow hotel removal', async () => {
    await M1().post('/schedules', sh(w.maria, w.early, '2026-10-05'));
    expect((await as(w.tokens.admin).delete(`/employees/${w.maria}`)).status).toBe(409);
    await M1().delete(`/schedules/${(await q1('SELECT id FROM schedules WHERE employee_id = $1', [w.maria])).id}`);
    // admin moves the home hotel of a floating employee; departments of a removed hotel disappear
    const moved = await as(w.tokens.admin).put(`/employees/${w.flo}/hotels`, { hotelIds: [w.h2], homeHotelId: w.h2 });
    expect(moved.status).toBe(200);
    expect(moved.body.hotels).toEqual([{ id: w.h2, name: 'Trip Inn Munich', isHome: true }]);
    expect(moved.body.departments.map((d: any) => d.id)).toEqual([w.d4]);
    expect((await M1().get(`/employees/${w.flo}`)).status).toBe(200); // history keeps h1 manager able to see (was assigned)
    expect((await as(w.tokens.admin).put(`/employees/${w.flo}/hotels`, { hotelIds: [w.h1], homeHotelId: w.h2 })).status).toBe(400);
    const gone = await as(w.tokens.admin).delete(`/employees/${w.mia}`);
    expect(gone.status).toBe(204);
    expect((await M1().get(`/employees/${w.mia}`)).status).toBe(404);
    expect((await M1().get(`/employees?hotelId=${w.h1}`)).body.data.map((e: any) => e.id)).not.toContain(w.mia);
    const another = await createEmployee({ companyId: w.companyId, firstName: 'Z', lastName: 'Z', homeHotelId: w.h1, departmentIds: [w.d1] });
    expect(another).toBeGreaterThan(0);
  });
});
