import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { createEmployee, patchSettings, setupWorld, World } from '../helpers/fixtures';
import { q, q1 } from '../helpers/db';
import { closePool } from '../../src/db/pool';
import { setNow } from '../../src/clock';

let w: World;
const M1 = () => as(w.tokens.manager1);
const M2 = () => as(w.tokens.manager2);

async function mkShift(name: string, startTime: string, endTime: string, breakDurationMinutes: number, departmentId?: number) {
  const res = await as(w.tokens.admin).post('/shifts', { hotelId: w.h1, departmentId: departmentId ?? w.d1, name, startTime, endTime, breakDurationMinutes });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

function shift(employeeId: number, shiftId: number, date: string, extra: Record<string, unknown> = {}) {
  return { hotelId: w.h1, entryType: 'shift', employeeId, shiftId, date, ...extra };
}

const types = (res: any) => (res.body.warnings ?? []).map((x: any) => x.type);
const minorRules = (res: any) => (res.body.warnings ?? []).find((x: any) => x.type === 'minor_protection')?.details.map((d: any) => d.rule) ?? [];

describe('Phase 5: roster', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('#23 shift of another department → 422 EMPLOYEE_NOT_IN_DEPARTMENT', async () => {
    const res = await M1().post('/schedules', shift(w.maria, w.hk, '2026-10-05'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EMPLOYEE_NOT_IN_DEPARTMENT');
  });

  it('#24 same shift twice on a date → 409 EMPLOYEE_ALREADY_SCHEDULED', async () => {
    expect((await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'))).status).toBe(201);
    const res = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMPLOYEE_ALREADY_SCHEDULED');
  });

  it('#25 shift or off on an approved absence → 422 EMPLOYEE_ON_TIME_OFF', async () => {
    expect((await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-10-05', endDate: '2026-10-06' })).status).toBe(201);
    const s = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'));
    expect(s.status).toBe(422);
    expect(s.body.error.code).toBe('EMPLOYEE_ON_TIME_OFF');
    const off = await M1().post('/schedules', { hotelId: w.h1, entryType: 'off', employeeId: w.maria, date: '2026-10-06', offLabel: 'Frei' });
    expect(off.status).toBe(422);
    expect(off.body.error.code).toBe('EMPLOYEE_ON_TIME_OFF');
  });

  it('#26 past date in hotel time zone → 422 SCHEDULE_DATE_IN_PAST', async () => {
    setNow('2026-09-30T22:30:00Z'); // already 1 Oct 00:30 in Frankfurt
    const res = await M1().post('/schedules', shift(w.maria, w.early, '2026-09-30'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SCHEDULE_DATE_IN_PAST');
    const admin = await as(w.tokens.admin).post('/schedules', shift(w.maria, w.early, '2026-09-30', { allowPast: true }));
    expect(admin.status).toBe(201);
    const audit = await q1(`SELECT meta FROM audit_logs WHERE action = 'schedule.create' AND entity_id = $1`, [admin.body.id]);
    expect(audit.meta.allowPast).toBe(true);
  });

  it('#27 Late 14–22 then Early 06–14 next day → insufficient_rest_period (8 h)', async () => {
    expect((await M1().post('/schedules', shift(w.maria, w.late, '2026-10-05'))).status).toBe(201);
    const res = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-06'));
    expect(res.status).toBe(201);
    expect(res.body.restPeriodHours).toBe(8);
    const warn = res.body.warnings.find((x: any) => x.type === 'insufficient_rest_period');
    expect(warn).toMatchObject({ severity: 'warning', gapHours: 8, previousShift: { date: '2026-10-05', shiftName: 'Late', endTime: '22:00', hotelName: 'Trip Inn Frankfurt' } });
    expect(res.body).toMatchObject({ paidHoursAssigned: 7.5, currentWeekHours: 15, weeklyTarget: 40, monthlyTarget: 160, status: 'draft' });
  });

  it('#28 Night Mon, Late Tue 14:00: gap across midnight', async () => {
    expect((await M1().post('/schedules', shift(w.maria, w.night, '2026-10-05'))).status).toBe(201);
    const res = await M1().post('/schedules', shift(w.maria, w.late, '2026-10-06'));
    expect(res.status).toBe(201);
    expect(res.body.restPeriodHours).toBe(8);
    expect(types(res)).toContain('insufficient_rest_period');
  });

  it('#29 night shift ending on the clock-change morning uses real instants', async () => {
    const nine = await mkShift('Nine', '09:00', '17:00', 30);
    expect((await M1().post('/schedules', shift(w.maria, w.night, '2026-10-24'))).status).toBe(201);
    const res = await M1().post('/schedules', shift(w.maria, nine, '2026-10-25'));
    expect(res.status).toBe(201);
    expect(res.body.restPeriodHours).toBe(3);
  });

  it('#30 weekly paid hours above max → exceeds_max_week', async () => {
    await M1().put(`/employees/${w.maria}/work-targets`, { targetHoursPerWeek: 15, minHoursPerWeek: 10, maxHoursPerWeek: 20 });
    await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'));
    const second = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-06'));
    expect(types(second)).toEqual([]);
    const third = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-07'));
    expect(third.status).toBe(201);
    expect(types(third)).toContain('exceeds_max_week');
    expect(third.body.currentWeekHours).toBe(22.5);
  });

  it('#31 /schedules/validate: same warnings, nothing saved', async () => {
    await M1().post('/schedules', shift(w.maria, w.late, '2026-10-05'));
    const dry = await M1().post('/schedules/validate', shift(w.maria, w.early, '2026-10-06'));
    expect(dry.status).toBe(200);
    expect(dry.body.id).toBeUndefined();
    expect(types(dry)).toContain('insufficient_rest_period');
    const count = await q1('SELECT count(*)::int n FROM schedules WHERE employee_id = $1', [w.maria]);
    expect(count.n).toBe(1);
  });

  it('#32 two parallel POSTs for the same employee/date → one 201, one 409', async () => {
    const [a, b] = await Promise.all([
      M1().post('/schedules', shift(w.maria, w.early, '2026-10-05')),
      M1().post('/schedules', shift(w.maria, w.early, '2026-10-05')),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it('#33 off entries count 0 hours', async () => {
    await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'));
    const off = await M1().post('/schedules', { hotelId: w.h1, entryType: 'off', employeeId: w.maria, date: '2026-10-06', offLabel: 'Frei' });
    expect(off.status).toBe(201);
    expect(off.body).toMatchObject({ entryType: 'off', offLabel: 'Frei', paidHoursAssigned: 0, currentWeekHours: 7.5, shift: null });
    const bad = await M1().post('/schedules', { hotelId: w.h1, entryType: 'off', employeeId: w.maria, shiftId: w.early, date: '2026-10-07' });
    expect(bad.status).toBe(400);
  });

  it('#34 bulk partial: 10 items, 2 invalid', async () => {
    const items = [] as any[];
    for (let d = 5; d <= 9; d++) items.push({ entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: `2026-10-0${d}` });
    for (let d = 5; d <= 7; d++) items.push({ entryType: 'shift', employeeId: w.jon, shiftId: w.hk, date: `2026-10-0${d}` });
    items.push({ entryType: 'shift', employeeId: w.maria, shiftId: w.hk, date: '2026-10-08' }); // wrong department
    items.push({ entryType: 'shift', employeeId: w.jon, shiftId: w.early, date: '2026-09-29' }); // past
    const res = await M1().post('/schedules/bulk', { hotelId: w.h1, mode: 'partial', items });
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ created: 8, failed: 2 });
    expect(res.body.results[8]).toMatchObject({ index: 8, status: 'error', error: { code: 'EMPLOYEE_NOT_IN_DEPARTMENT' } });
    expect(res.body.results[9].error.code).toBe('SCHEDULE_DATE_IN_PAST');
    const atomic = await M1().post('/schedules/bulk', { hotelId: w.h1, mode: 'atomic', items: [
      { entryType: 'shift', employeeId: w.flo, shiftId: w.early, date: '2026-10-12' },
      { entryType: 'shift', employeeId: w.flo, shiftId: w.hk, date: '2026-10-13' },
    ] });
    expect(atomic.status).toBe(409);
    expect(atomic.body.error.code).toBe('BULK_FAILED');
    expect(atomic.body.summary).toEqual({ created: 0, failed: 1 });
    expect((await q('SELECT 1 FROM schedules WHERE employee_id = $1', [w.flo])).length).toBe(0);
  });

  it('#35 copy a week while one employee is on vacation', async () => {
    for (const d of ['05', '06', '07']) {
      await M1().post('/schedules', shift(w.maria, w.early, `2026-10-${d}`));
      await M1().post('/schedules', shift(w.jon, w.late, `2026-10-${d}`));
    }
    await M1().post(`/employees/${w.jon}/time-offs`, { type: 'annual_leave', startDate: '2026-10-12', endDate: '2026-10-16' });
    const res = await M1().post('/schedules/copy', { hotelId: w.h1, sourceFrom: '2026-10-05', sourceTo: '2026-10-11', targetFrom: '2026-10-12' });
    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(3);
    expect(res.body.skipped).toHaveLength(3);
    expect(res.body.skipped[0]).toMatchObject({ employeeId: w.jon, reason: 'on_time_off' });
    const copied = await q(`SELECT status FROM schedules WHERE employee_id = $1 AND date >= '2026-10-12'`, [w.maria]);
    expect(copied.every((c) => c.status === 'draft')).toBe(true);
    const past = await M1().post('/schedules/copy', { hotelId: w.h1, sourceFrom: '2026-10-05', sourceTo: '2026-10-11', targetFrom: '2026-09-28' });
    expect(past.status).toBe(422);
  });

  it('#36 publish: staff sees only published entries', async () => {
    const e = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'));
    const before = await as(w.tokens.maria).get('/schedules?employeeId=me&from=2026-10-05&to=2026-10-11');
    expect(before.body.data).toEqual([]);
    const pub = await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-05', to: '2026-10-11' });
    expect(pub.status).toBe(200);
    expect(pub.body).toEqual({ published: 1, from: '2026-10-05', to: '2026-10-11' });
    const after = await as(w.tokens.maria).get('/schedules?employeeId=me&from=2026-10-05&to=2026-10-11');
    expect(after.body.data.map((x: any) => x.id)).toEqual([e.body.id]);
    expect(after.body.data[0]).not.toHaveProperty('warnings');
    const draft = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-06'));
    expect(draft.body.status).toBe('draft');
    const still = await as(w.tokens.maria).get('/schedules?employeeId=me&from=2026-10-05&to=2026-10-11');
    expect(still.body.data).toHaveLength(1);
    expect((await as(w.tokens.maria).get(`/schedules/${draft.body.id}`)).status).toBe(404);
  });

  it('#37 absence approved after drafting → 409 PUBLISH_CONFLICTS, nothing published', async () => {
    const a = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'));
    await M1().post('/schedules', shift(w.jon, w.early, '2026-10-05'));
    const sick = await M1().post(`/employees/${w.maria}/time-offs`, { type: 'sick_leave', startDate: '2026-10-05', endDate: '2026-10-05' });
    expect(sick.body.conflicts).toEqual([a.body.id]);
    const pub = await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-05', to: '2026-10-11' });
    expect(pub.status).toBe(409);
    expect(pub.body.error.code).toBe('PUBLISH_CONFLICTS');
    expect(pub.body.error.details).toEqual([{ scheduleId: a.body.id, code: 'EMPLOYEE_ON_TIME_OFF' }]);
    expect((await q(`SELECT 1 FROM schedules WHERE status = 'published'`)).length).toBe(0);
  });

  it('#38 editing a published shift 24 h before start → short_notice_change', async () => {
    const e = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-02'));
    await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-02', to: '2026-10-02' });
    const res = await M1().patch(`/schedules/${e.body.id}`, { shiftId: w.late });
    expect(res.status).toBe(200);
    expect(types(res)).toContain('short_notice_change');
    expect(res.body.status).toBe('published');
    const del = await M1().delete(`/schedules/${e.body.id}`);
    expect(del.status).toBe(200);
    expect(del.body.id).toBe(e.body.id);
    expect(del.body.warnings[0].type).toBe('short_notice_change');
  });

  it('#39 unpublish a past date → 422', async () => {
    const res = await M1().post('/schedules/unpublish', { hotelId: w.h1, from: '2026-09-28', to: '2026-10-04' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SCHEDULE_DATE_IN_PAST');
    await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'));
    await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-05', to: '2026-10-05' });
    const ok = await M1().post('/schedules/unpublish', { hotelId: w.h1, from: '2026-10-05', to: '2026-10-11' });
    expect(ok.body.unpublished).toBe(1);
  });

  it('#40 warnings + overrideReason are stored and audited', async () => {
    await M1().post('/schedules', shift(w.maria, w.late, '2026-10-05'));
    const res = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-06', { overrideReason: 'Short-staffed, agreed with employee' }));
    expect(res.status).toBe(201);
    expect(res.body.overrideReason).toBe('Short-staffed, agreed with employee');
    const row = await q1('SELECT override_reason, warnings FROM schedules WHERE id = $1', [res.body.id]);
    expect(row.override_reason).toBe('Short-staffed, agreed with employee');
    expect(row.warnings[0].type).toBe('insufficient_rest_period');
    const audit = await q1(`SELECT meta FROM audit_logs WHERE action = 'schedule.create' AND entity_id = $1`, [res.body.id]);
    expect(audit.meta.overrideReason).toBe('Short-staffed, agreed with employee');
    expect(audit.meta.warnings).toContain('insufficient_rest_period');
  });

  it('#66 manager of hotel 2 rosters the floating employee at hotel 2', async () => {
    const res = await M2().post('/schedules', { hotelId: w.h2, entryType: 'shift', employeeId: w.flo, shiftId: w.early2, date: '2026-10-05' });
    expect(res.status).toBe(201);
    expect(res.body.hotelId).toBe(w.h2);
  });

  it('#67 overlap across hotels → 409 SHIFT_OVERLAPS_EXISTING', async () => {
    expect((await M1().post('/schedules', shift(w.flo, w.early, '2026-10-05'))).status).toBe(201);
    const res = await M2().post('/schedules', { hotelId: w.h2, entryType: 'shift', employeeId: w.flo, shiftId: w.early2, date: '2026-10-05' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIFT_OVERLAPS_EXISTING');
    expect(res.body.error.details[0].hotelName).toBe('Trip Inn Frankfurt');
  });

  it('#68 employee not assigned to hotel 2 (or unassigned before the date)', async () => {
    const res = await M2().post('/schedules', { hotelId: w.h2, entryType: 'shift', employeeId: w.maria, shiftId: w.early2, date: '2026-10-05' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EMPLOYEE_NOT_ASSIGNED_TO_HOTEL');
    await q(`UPDATE employee_hotels SET unassigned_on = '2026-10-03' WHERE employee_id = $1 AND hotel_id = $2`, [w.flo, w.h2]);
    const later = await M2().post('/schedules', { hotelId: w.h2, entryType: 'shift', employeeId: w.flo, shiftId: w.early2, date: '2026-10-05' });
    expect(later.status).toBe(422);
    expect(later.body.error.code).toBe('EMPLOYEE_NOT_ASSIGNED_TO_HOTEL');
    const before = await M2().post('/schedules', { hotelId: w.h2, entryType: 'shift', employeeId: w.flo, shiftId: w.early2, date: '2026-10-03' });
    expect(before.status).toBe(201);
  });

  it('#69 Late at hotel 1, Early next day at hotel 2: rest warning names the hotel; totals count both', async () => {
    expect((await M1().post('/schedules', shift(w.flo, w.late, '2026-10-05'))).status).toBe(201);
    const res = await M2().post('/schedules', { hotelId: w.h2, entryType: 'shift', employeeId: w.flo, shiftId: w.early2, date: '2026-10-06' });
    expect(res.status).toBe(201);
    const warn = res.body.warnings.find((x: any) => x.type === 'insufficient_rest_period');
    expect(warn.previousShift.hotelName).toBe('Trip Inn Frankfurt');
    expect(res.body.currentWeekHours).toBe(15);
  });

  it('#70 home manager approves leave; hotel 2 manager cannot roster that day', async () => {
    await M1().post(`/employees/${w.flo}/time-offs`, { type: 'annual_leave', startDate: '2026-10-07', endDate: '2026-10-07' });
    const res = await M2().post('/schedules', { hotelId: w.h2, entryType: 'shift', employeeId: w.flo, shiftId: w.early2, date: '2026-10-07' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EMPLOYEE_ON_TIME_OFF');
  });

  it('#72 removing hotel 2 while future entries exist → 409; afterwards 200 with history', async () => {
    const e = await M2().post('/schedules', { hotelId: w.h2, entryType: 'shift', employeeId: w.flo, shiftId: w.early2, date: '2026-10-05' });
    const res = await as(w.tokens.regional).put(`/employees/${w.flo}/hotels`, { hotelIds: [w.h1], homeHotelId: w.h1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESOURCE_IN_USE');
    expect((await M2().delete(`/schedules/${e.body.id}`)).status).toBe(200);
    const ok = await as(w.tokens.regional).put(`/employees/${w.flo}/hotels`, { hotelIds: [w.h1], homeHotelId: w.h1 });
    expect(ok.status).toBe(200);
    expect((await M2().get(`/employees/${w.flo}`)).status).toBe(200);
    const after = await M2().post('/schedules', { hotelId: w.h2, entryType: 'shift', employeeId: w.flo, shiftId: w.early2, date: '2026-10-05' });
    expect(after.body.error.code).toBe('EMPLOYEE_NOT_ASSIGNED_TO_HOTEL');
  });

  it('#76 sick leave with unassignConflicts removes entries at both hotels (audited)', async () => {
    const a = await M1().post('/schedules', shift(w.flo, w.early, '2026-10-05'));
    const b = await M2().post('/schedules', { hotelId: w.h2, entryType: 'shift', employeeId: w.flo, shiftId: w.early2, date: '2026-10-06' });
    const res = await M1().post(`/employees/${w.flo}/time-offs`, { type: 'sick_leave', startDate: '2026-10-05', endDate: '2026-10-06', unassignConflicts: true });
    expect(res.status).toBe(201);
    expect(res.body.conflicts.sort()).toEqual([a.body.id, b.body.id].sort());
    expect(res.body.conflictDetails.map((c: any) => c.hotelName).sort()).toEqual(['Trip Inn Frankfurt', 'Trip Inn Munich']);
    expect((await q('SELECT 1 FROM schedules WHERE employee_id = $1', [w.flo])).length).toBe(0);
    const audits = await q(`SELECT hotel_id FROM audit_logs WHERE action = 'schedule.delete' AND entity_id = ANY($1::bigint[])`, [[a.body.id, b.body.id]]);
    expect(audits.map((x) => x.hotel_id).sort()).toEqual([w.h1, w.h2].sort());
  });

  it('#77 Breakfast 06–10 and Dinner 17–21: both 201, second has split_shift_span', async () => {
    expect((await M1().post('/schedules', shift(w.maria, w.breakfast, '2026-10-05'))).status).toBe(201);
    const res = await M1().post('/schedules', shift(w.maria, w.dinner, '2026-10-05'));
    expect(res.status).toBe(201);
    expect(res.body.warnings.find((x: any) => x.type === 'split_shift_span')).toMatchObject({ severity: 'info', spanHours: 15 });
  });

  it('#78 overlapping shifts on the same day → 409', async () => {
    await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'));
    const res = await M1().post('/schedules', shift(w.maria, w.mid, '2026-10-05'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIFT_OVERLAPS_EXISTING');
  });

  it('#79 Night Mon 22–06, then 05:00 Tue → 409 / 06:00 Tue → 201', async () => {
    const dawn = await mkShift('Dawn', '05:00', '09:00', 0);
    await M1().post('/schedules', shift(w.maria, w.night, '2026-10-05'));
    const bad = await M1().post('/schedules', shift(w.maria, dawn, '2026-10-06'));
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('SHIFT_OVERLAPS_EXISTING');
    const ok = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-06'));
    expect(ok.status).toBe(201);
    expect(ok.body.restPeriodHours).toBe(0);
  });

  it('#80 a third shift with maxShiftsPerDay = 2 → 422', async () => {
    const lunch = await mkShift('Lunch', '11:00', '15:00', 0);
    await M1().post('/schedules', shift(w.maria, w.breakfast, '2026-10-05'));
    await M1().post('/schedules', shift(w.maria, w.dinner, '2026-10-05'));
    const res = await M1().post('/schedules', shift(w.maria, lunch, '2026-10-05'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MAX_SHIFTS_PER_DAY_EXCEEDED');
  });

  it('#81 day off vs shift in both orders → 409', async () => {
    await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'));
    const off = await M1().post('/schedules', { hotelId: w.h1, entryType: 'off', employeeId: w.maria, date: '2026-10-05' });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('EMPLOYEE_ALREADY_SCHEDULED');
    await M1().post('/schedules', { hotelId: w.h1, entryType: 'off', employeeId: w.maria, date: '2026-10-06' });
    const s = await M1().post('/schedules', shift(w.maria, w.early, '2026-10-06'));
    expect(s.status).toBe(409);
    expect(s.body.error.code).toBe('EMPLOYEE_ALREADY_SCHEDULED');
  });

  it('#82 split day: no rest warning between parts; daily max uses the day total', async () => {
    const a = await mkShift('Part A', '06:00', '12:00', 0);
    const b = await mkShift('Part B', '13:00', '19:00', 0);
    await M1().post('/schedules', shift(w.maria, a, '2026-10-05'));
    const res = await M1().post('/schedules', shift(w.maria, b, '2026-10-05'));
    expect(res.status).toBe(201);
    expect(types(res)).not.toContain('insufficient_rest_period');
    expect(res.body.warnings.find((x: any) => x.type === 'exceeds_daily_max')).toMatchObject({ actualHours: 12, limitHours: 10 });
    expect(res.body.restPeriodHours).toBeNull();
  });

  it('#83 PATCH a shift into an overlap → 409', async () => {
    await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'));
    const late = await M1().post('/schedules', shift(w.maria, w.late, '2026-10-05'));
    const res = await M1().patch(`/schedules/${late.body.id}`, { shiftId: w.mid });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIFT_OVERLAPS_EXISTING');
  });

  it('#84 17-year-old, 9 h shift: warn with / without reason; block mode', async () => {
    const long9 = await mkShift('Long9', '08:00', '17:30', 30);
    const without = await M1().post('/schedules', shift(w.mia, long9, '2026-10-05'));
    expect(without.status).toBe(422);
    expect(without.body.error.code).toBe('OVERRIDE_REASON_REQUIRED');
    const withReason = await M1().post('/schedules', shift(w.mia, long9, '2026-10-05', { overrideReason: 'Exam preparation event, agreed' }));
    expect(withReason.status).toBe(201);
    const warn = withReason.body.warnings.find((x: any) => x.type === 'minor_protection');
    expect(warn.details).toContainEqual({ rule: 'daily_limit', limit: 8, actual: 9 });
    const audit = await q1(`SELECT meta FROM audit_logs WHERE action = 'schedule.create' AND entity_id = $1`, [withReason.body.id]);
    expect(audit.meta.minorRules).toContain('daily_limit');
    await patchSettings(w.h1, (s) => (s.legal.minors.enforcement = 'block'));
    const blocked = await M1().post('/schedules', shift(w.mia, long9, '2026-10-06', { overrideReason: 'please' }));
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('MINOR_PROTECTION_VIOLATION');
    expect(blocked.body.error.details.map((d: any) => d.rule)).toContain('daily_limit');
  });

  it('#85 shift ending 21:00: 16-year-old allowed, 15-year-old latest_end', async () => {
    const eve = await mkShift('Evening', '13:00', '21:00', 60);
    const sixteen = await createEmployee({ companyId: w.companyId, firstName: 'Six', lastName: 'Teen', homeHotelId: w.h1, departmentIds: [w.d1], birthDate: '2010-01-01' });
    const fifteen = await createEmployee({ companyId: w.companyId, firstName: 'Fif', lastName: 'Teen', homeHotelId: w.h1, departmentIds: [w.d1], birthDate: '2011-03-01' });
    const a = await M1().post('/schedules', shift(sixteen, eve, '2026-10-05'));
    expect(a.status).toBe(201);
    expect(types(a)).not.toContain('minor_protection');
    const b = await M1().post('/schedules', shift(fifteen, eve, '2026-10-05', { overrideReason: 'event' }));
    expect(b.status).toBe(201);
    expect(minorRules(b)).toEqual(['latest_end']);
  });

  it('#86 minor: 36 h rostered plus a school day → weekly_limit', async () => {
    const long9 = await mkShift('Long9', '08:00', '17:30', 30);
    expect((await M1().post(`/employees/${w.mia}/time-offs`, { type: 'school', startDate: '2026-10-16', endDate: '2026-10-16' })).status).toBe(201);
    let last: any;
    for (const d of ['12', '13', '14', '15']) {
      last = await M1().post('/schedules', shift(w.mia, long9, `2026-10-${d}`, { overrideReason: 'season peak' }));
      expect(last.status).toBe(201);
    }
    const weekly = last.body.warnings.find((x: any) => x.type === 'minor_protection').details.find((d: any) => d.rule === 'weekly_limit');
    expect(weekly).toEqual({ rule: 'weekly_limit', limit: 40, actual: 44 });
  });

  it('#87 minor: 10 h between shifts of two days → rest_period', async () => {
    const eight = await mkShift('Eight', '08:00', '16:00', 30);
    await M1().post('/schedules', shift(w.mia, w.late, '2026-10-05', { overrideReason: 'x' }));
    const res = await M1().post('/schedules', shift(w.mia, eight, '2026-10-06', { overrideReason: 'x' }));
    expect(res.status).toBe(201);
    expect(minorRules(res)).toContain('rest_period');
  });

  it('#88 minor: night shift crossing midnight → night_work', async () => {
    const res = await M1().post('/schedules', shift(w.mia, w.night, '2026-10-05', { overrideReason: 'x' }));
    expect(res.status).toBe(201);
    expect(minorRules(res)).toContain('night_work');
  });

  it('#89 minor: sixth working day in a week → days_per_week', async () => {
    let res: any;
    for (const d of ['05', '06', '07', '08', '09']) {
      res = await M1().post('/schedules', shift(w.mia, w.breakfast, `2026-10-${d}`));
      expect(res.status).toBe(201);
      expect(minorRules(res)).toEqual([]);
    }
    const sixth = await M1().post('/schedules', shift(w.mia, w.breakfast, '2026-10-10'));
    expect(sixth.status).toBe(422);
    const ok = await M1().post('/schedules', shift(w.mia, w.breakfast, '2026-10-10', { overrideReason: 'inventory' }));
    expect(ok.status).toBe(201);
    expect(minorRules(ok)).toEqual(['days_per_week']);
    expect(types(ok)).toContain('minor_weekend_holiday_check');
  });

  it('#90 minor: 7 h shift with 30 min break → break', async () => {
    const seven = await mkShift('Seven', '08:00', '15:30', 30);
    const res = await M1().post('/schedules', shift(w.mia, seven, '2026-10-05', { overrideReason: 'x' }));
    expect(res.status).toBe(201);
    expect(res.body.warnings.find((x: any) => x.type === 'minor_protection').details).toEqual([{ rule: 'break', limit: 60, actual: 30 }]);
  });

  it('#91 apprentice school days block the roster and credit a normal day', async () => {
    expect((await M1().post(`/employees/${w.mia}/time-offs`, { type: 'school', startDate: '2026-10-07', endDate: '2026-10-07' })).status).toBe(201);
    const res = await M1().post('/schedules', shift(w.mia, w.breakfast, '2026-10-07'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EMPLOYEE_ON_TIME_OFF');
    const sum = await M1().get(`/employees/${w.mia}/work-summary?from=2026-10-05&to=2026-10-11`);
    expect(sum.status).toBe(200);
    expect(sum.body.creditedHours).toBe(8);
  });

  it('#92 turning 18 during the week: adult rules from the birthday', async () => {
    const long9 = await mkShift('Long9', '08:00', '17:30', 30);
    const eighteen = await createEmployee({ companyId: w.companyId, firstName: 'Almost', lastName: 'Adult', homeHotelId: w.h1, departmentIds: [w.d1], birthDate: '2008-10-07' });
    const before = await M1().post('/schedules', shift(eighteen, long9, '2026-10-06'));
    expect(before.status).toBe(422);
    expect(before.body.error.code).toBe('OVERRIDE_REASON_REQUIRED');
    const after = await M1().post('/schedules', shift(eighteen, long9, '2026-10-07'));
    expect(after.status).toBe(201);
    expect(types(after)).not.toContain('minor_protection');
  });

  it('#111 cover finder', async () => {
    const date = '2026-10-12';
    // absent
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: date, endDate: date });
    // overlapping (Mid 10–18 overlaps Early 06–14)
    const other = await createEmployee({ companyId: w.companyId, firstName: 'Busy', lastName: 'Bee', homeHotelId: w.h1, departmentIds: [w.d1] });
    await M1().post('/schedules', shift(other, w.mid, date));
    // wrong department only
    const hkOnly = await createEmployee({ companyId: w.companyId, firstName: 'House', lastName: 'Keeper', homeHotelId: w.h1, departmentIds: [w.d2] });
    // jon prefers the Early shift
    await as(w.tokens.jon).post('/employees/me/shift-wishes', { date, shiftId: w.early, kind: 'prefer', priority: 1 });
    // minor violating in block mode (7.5 h with 30 min break)
    await patchSettings(w.h1, (s) => (s.legal.minors.enforcement = 'block'));
    const res = await M1().get(`/schedules/candidates?hotelId=${w.h1}&date=${date}&shiftId=${w.early}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: any) => c.employee.id);
    expect(ids).not.toContain(w.maria);
    expect(ids).not.toContain(other);
    expect(ids).not.toContain(hkOnly);
    expect(ids).not.toContain(w.mia);
    expect(ids).toContain(w.flo);
    expect(ids[0]).toBe(w.jon);
    expect(res.body.data[0]).toMatchObject({ wish: 'prefer', isFloating: false, weeklyHoursSoFar: 0, employee: { displayName: 'Jon S.' } });
    await patchSettings(w.h1, (s) => (s.legal.minors.enforcement = 'warn'));
    const warnMode = await M1().get(`/schedules/candidates?hotelId=${w.h1}&date=${date}&shiftId=${w.early}`);
    const mia = warnMode.body.data.find((c: any) => c.employee.id === w.mia);
    expect(mia.minorWarning).toBe(true);
  });

  it('#117 bulk with a minor warning: per-item overrideReason', async () => {
    const seven = await mkShift('Seven', '08:00', '15:30', 30);
    const res = await M1().post('/schedules/bulk', { hotelId: w.h1, mode: 'partial', items: [
      { entryType: 'shift', employeeId: w.mia, shiftId: seven, date: '2026-10-05', overrideReason: 'trade fair' },
      { entryType: 'shift', employeeId: w.mia, shiftId: seven, date: '2026-10-07' },
    ] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('created');
    expect(res.body.results[1]).toMatchObject({ status: 'error', error: { code: 'OVERRIDE_REASON_REQUIRED' } });
  });

  it('lists, coverage, work summary and staff plan visibility', async () => {
    await M1().put(`/shifts/${w.early}/staffing-requirements`, { requirements: [{ weekday: 1, minStaff: 2 }] });
    await M1().post('/schedules', shift(w.maria, w.early, '2026-10-05'));
    await M1().post('/schedules', shift(w.jon, w.hk, '2026-10-05'));
    await M1().post('/schedules', { hotelId: w.h1, entryType: 'off', employeeId: w.flo, date: '2026-10-05', offLabel: 'Frei' });
    const cov = await M1().get(`/schedules/coverage?hotelId=${w.h1}&from=2026-10-05&to=2026-10-05`);
    expect(cov.body.data.find((c: any) => c.shiftId === w.early)).toMatchObject({ scheduled: 1, minStaff: 2, understaffed: true });
    expect(cov.body.data.find((c: any) => c.shiftId === w.late)).toMatchObject({ scheduled: 0, minStaff: null, understaffed: false });
    const list = await M1().get(`/schedules?hotelId=${w.h1}&from=2026-10-05&to=2026-10-11&departmentId=${w.d1}`);
    expect(list.body.data.map((x: any) => x.employee.id).sort()).toEqual([w.maria, w.flo].sort());
    const tooLong = await M1().get(`/schedules?hotelId=${w.h1}&from=2026-10-01&to=2026-12-31`);
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.code).toBe('RANGE_TOO_LARGE');
    await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-05', to: '2026-10-11' });
    const plan = await as(w.tokens.maria).get('/schedules?from=2026-10-05&to=2026-10-11');
    expect(plan.status).toBe(200);
    expect(plan.body.data).toEqual([
      { date: '2026-10-05', department: { id: w.d1, name: 'Front Desk' }, shift: { name: 'Early', startTime: '06:00', endTime: '14:00' }, employee: { displayName: 'Maria G.' }, isMine: true },
    ]);
    const summary = await as(w.tokens.maria).get('/employees/me/work-summary?from=2026-10-05&to=2026-10-11');
    expect(summary.body).toMatchObject({ scheduledPaidHours: 7.5, creditedHours: 0, targetHours: 40, delta: -32.5 });
    expect(summary.body.weeks[0].status).toBe('below');
  });
});
