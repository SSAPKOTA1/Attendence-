import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { setupWorld, World } from '../helpers/fixtures';
import { q1 } from '../helpers/db';
import { closePool } from '../../src/db/pool';

let w: World;

describe('Phase 2: departments, shifts, staffing', () => {
  beforeAll(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('#8 shift 22:00–06:00 with 60 min break', async () => {
    const res = await as(w.tokens.manager1).post('/shifts', { hotelId: w.h1, departmentId: w.d2, name: 'Night HK', startTime: '22:00', endTime: '06:00', breakDurationMinutes: 60 });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/shifts/${res.body.id}`);
    expect(res.body).toMatchObject({ durationHours: 8, paidHours: 7, breakDurationMinutes: 60, startTime: '22:00', endTime: '06:00' });
    expect(res.body.warnings).toEqual([]);
  });

  it('#9 break >= duration → 400', async () => {
    const res = await as(w.tokens.manager1).post('/shifts', { hotelId: w.h1, departmentId: w.d2, name: 'Bad', startTime: '08:00', endTime: '09:00', breakDurationMinutes: 60 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('#10 delete a department that has shifts → 409 RESOURCE_IN_USE', async () => {
    const res = await as(w.tokens.manager1).delete(`/departments/${w.d1}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESOURCE_IN_USE');
    const empty = await as(w.tokens.manager1).post('/departments', { hotelId: w.h1, name: 'Spa', color: '#112233' });
    expect(empty.status).toBe(201);
    expect((await as(w.tokens.manager1).delete(`/departments/${empty.body.id}`)).status).toBe(204);
  });

  it('#11 8 h shift with 15 min break → 201 + break_insufficient', async () => {
    const res = await as(w.tokens.manager1).post('/shifts', { hotelId: w.h1, departmentId: w.d3, name: 'Cook', startTime: '08:00', endTime: '16:00', breakDurationMinutes: 15 });
    expect(res.status).toBe(201);
    expect(res.body.warnings[0]).toMatchObject({ type: 'break_insufficient', severity: 'warning' });
  });

  it('duplicate department name → 409, staffing requirements round-trip', async () => {
    const dup = await as(w.tokens.manager1).post('/departments', { hotelId: w.h1, name: 'front desk' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_RESOURCE');
    const put = await as(w.tokens.manager1).put(`/shifts/${w.early}/staffing-requirements`, { requirements: [{ weekday: 1, minStaff: 2 }, { weekday: 6, minStaff: 1 }] });
    expect(put.status).toBe(200);
    expect(put.body.data).toEqual([{ weekday: 1, minStaff: 2 }, { weekday: 6, minStaff: 1 }]);
    expect((await as(w.tokens.maria).get(`/shifts/${w.early}/staffing-requirements`)).status).toBe(403);
  });

  it('staff list shifts and departments of their hotel', async () => {
    const res = await as(w.tokens.maria).get('/shifts');
    expect(res.status).toBe(200);
    expect(res.body.data.every((s: any) => s.hotelId === w.h1)).toBe(true);
    const flo = await as(w.tokens.flo).get('/departments');
    expect(flo.status).toBe(400); // two hotels → hotelId required
  });
});

describe('Phase 3: employees, assignments, holidays', () => {
  it('#12 workWeekdays [0,9] → 400', async () => {
    const res = await as(w.tokens.manager1).post('/employees', { payType: 'salary', firstName: 'A', lastName: 'B', homeHotelId: w.h1, workWeekdays: [0, 9], departmentIds: [w.d1] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('#93 employee born less than 15 years ago → 400', async () => {
    const res = await as(w.tokens.manager1).post('/employees', { payType: 'salary', firstName: 'Kid', lastName: 'Young', homeHotelId: w.h1, birthDate: '2012-01-01', departmentIds: [w.d1] });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('birthDate');
  });

  it('creates a floating employee with hotels and departments', async () => {
    const res = await as(w.tokens.regional).post('/employees', { payType: 'salary',
      firstName: 'Maria', lastName: 'Garcia', email: 'mg@x.de', phone: '1', hourlyRate: 15.5, workWeekdays: [1, 2, 3, 4, 5], employeeNumber: 'P900',
      birthDate: '2010-03-04', hiredOn: '2026-09-01', employmentType: 'apprentice', attendanceRequired: true, homeHotelId: w.h1, hotelIds: [w.h1, w.h2], departmentIds: [w.d1, w.d4],
    });
    expect(res.status).toBe(201);
    expect(res.body.homeHotelId).toBe(w.h1);
    expect(res.body.hotels).toEqual([
      { id: w.h1, name: 'Trip Inn Frankfurt', isHome: true },
      { id: w.h2, name: 'Trip Inn Munich', isHome: false },
    ]);
    expect(res.body.departments.map((d: any) => d.id).sort()).toEqual([w.d1, w.d4].sort());
    const dupNumber = await as(w.tokens.regional).post('/employees', { payType: 'salary', firstName: 'X', lastName: 'Y', homeHotelId: w.h1, employeeNumber: 'P900' });
    expect(dupNumber.status).toBe(409);
    const wrongDept = await as(w.tokens.manager1).post('/employees', { payType: 'salary', firstName: 'X', lastName: 'Y', homeHotelId: w.h1, departmentIds: [w.d4] });
    expect(wrongDept.status).toBe(400);
  });

  it('#71 hotel 2 manager: reduced view of a floating employee, no master-data edits', async () => {
    const view = await as(w.tokens.manager2).get(`/employees/${w.flo}`);
    expect(view.status).toBe(200);
    expect(view.body.firstName).toBe('Flo');
    expect(view.body).not.toHaveProperty('hourlyRate');
    expect(view.body).not.toHaveProperty('email');
    expect(view.body).not.toHaveProperty('phone');
    expect(view.body).not.toHaveProperty('birthDate');
    const edit = await as(w.tokens.manager2).patch(`/employees/${w.flo}`, { hourlyRate: 20 });
    expect(edit.status).toBe(403);
    const home = await as(w.tokens.manager1).get(`/employees/${w.flo}`);
    expect(home.body.hourlyRate).toBe(15.5);
    const list = await as(w.tokens.manager2).get(`/employees?hotelId=${w.h2}`);
    const flo = list.body.data.find((e: any) => e.id === w.flo);
    expect(flo.isHome).toBe(false);
    expect(flo).not.toHaveProperty('hourlyRate');
    expect((await as(w.tokens.manager2).get(`/employees/${w.maria}`)).status).toBe(404);
  });

  it('work targets: home manager writes, validation via DB check', async () => {
    const ok = await as(w.tokens.manager1).put(`/employees/${w.jon}/work-targets`, { targetHoursPerWeek: 30, minHoursPerWeek: 20, maxHoursPerWeek: 40 });
    expect(ok.status).toBe(200);
    expect(ok.body.targetHoursPerWeek).toBe(30);
    const bad = await as(w.tokens.manager1).put(`/employees/${w.jon}/work-targets`, { minHoursPerWeek: 50 });
    expect(bad.status).toBe(400);
    expect((await as(w.tokens.manager2).put(`/employees/${w.flo}/work-targets`, { targetHoursPerWeek: 30 })).status).toBe(403);
  });

  it('PUT /employees/:id/hotels: assign, move home, unassign', async () => {
    const res = await as(w.tokens.regional).put(`/employees/${w.jon}/hotels`, { hotelIds: [w.h1, w.h2], homeHotelId: w.h2 });
    expect(res.status).toBe(200);
    expect(res.body.homeHotelId).toBe(w.h2);
    const notAllowed = await as(w.tokens.manager1).put(`/employees/${w.jon}/hotels`, { hotelIds: [w.h1], homeHotelId: w.h1 });
    expect(notAllowed.status).toBe(403);
    const back = await as(w.tokens.regional).put(`/employees/${w.jon}/hotels`, { hotelIds: [w.h1], homeHotelId: w.h1 });
    expect(back.status).toBe(200);
    expect(back.body.hotels).toEqual([{ id: w.h1, name: 'Trip Inn Frankfurt', isHome: true }]);
    const row = await q1('SELECT unassigned_on FROM employee_hotels WHERE employee_id = $1 AND hotel_id = $2', [w.jon, w.h2]);
    expect(row.unassigned_on).toBe('2026-10-01');
  });

  it('public holidays come from the hotel region', async () => {
    const he = await as(w.tokens.manager1).get(`/public-holidays?hotelId=${w.h1}&year=2027`);
    expect(he.status).toBe(200);
    expect(he.body.data.map((h: any) => h.date)).not.toContain('2027-01-06');
    const by = await as(w.tokens.regional).get(`/public-holidays?hotelId=${w.h2}&year=2027`);
    expect(by.body.data.map((h: any) => h.date)).toContain('2027-01-06');
  });
});
