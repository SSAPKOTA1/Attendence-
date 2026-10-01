import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { setupWorld, World } from '../helpers/fixtures';
import { q } from '../helpers/db';
import { closePool, getPool } from '../../src/db/pool';

let w: World;
const M1 = () => as(w.tokens.manager1);

const PII = ['firstname', 'lastname', 'email', 'phone', 'hourlyrate', 'password', 'pin', 'birthdate', 'passwordhash'];

function collectKeys(v: unknown, out: Set<string>) {
  if (Array.isArray(v)) v.forEach((x) => collectKeys(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k.replace(/_/g, '').toLowerCase());
      collectKeys(x, out);
    }
  }
}

describe('Phase 9: analytics and audit', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('#61 3 spells / 6 sick days → Bradford factor 54', async () => {
    for (const [s, e] of [['2026-09-01', '2026-09-02'], ['2026-09-08', '2026-09-09'], ['2026-09-15', '2026-09-16']]) {
      expect((await M1().post(`/employees/${w.jon}/time-offs`, { type: 'sick_leave', startDate: s, endDate: e })).status).toBe(201);
    }
    await M1().post('/attendance', { hotelId: w.h1, employeeId: w.jon, clockInAt: '2026-09-03T06:00:00Z', clockOutAt: '2026-09-03T14:00:00Z', reason: 'x' });
    const res = await M1().get(`/hotels/${w.h1}/analytics/absences?from=2026-09-01&to=2026-09-30`);
    expect(res.status).toBe(200);
    const jon = res.body.byEmployee.find((e: any) => e.employeeId === w.jon);
    expect(jon).toMatchObject({ sickDays: 6, spells: 3, bradfordFactor: 54, missingCertificates: 0 });
    expect(res.body.totals).toMatchObject({ sickDays: 6, spells: 3, employeesAffected: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(/reason|diagnos/i);
    // consecutive entries merge into one spell; a 4-day spell without certificate is flagged
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'sick_leave', startDate: '2026-09-21', endDate: '2026-09-22' });
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'sick_leave', startDate: '2026-09-23', endDate: '2026-09-24' });
    const res2 = await M1().get(`/hotels/${w.h1}/analytics/absences?from=2026-09-01&to=2026-09-30`);
    expect(res2.body.byEmployee.find((e: any) => e.employeeId === w.maria)).toMatchObject({ sickDays: 4, spells: 1, bradfordFactor: 4, missingCertificates: 1 });
    const trend = await M1().get(`/hotels/${w.h1}/analytics/absences/trend?from=2026-08-01&to=2026-09-30&granularity=month`);
    expect(trend.body.series.map((s: any) => [s.period, s.sickDays, s.spells])).toEqual([['2026-08', 0, 0], ['2026-09', 10, 4]]);
  });

  it('#62 audit_logs are append-only and PII-free', async () => {
    await M1().post('/employees', { firstName: 'Secret', lastName: 'Person', email: 'secret@x.de', phone: '0123', hourlyRate: 20, homeHotelId: w.h1, departmentIds: [w.d1], birthDate: '2000-01-01' });
    await M1().patch(`/employees/${w.jon}`, { firstName: 'Jonathan', phone: '999', hourlyRate: 18 });
    await as(w.tokens.admin).post('/users', { email: 'newmanager@x.de', role: 'manager', hotelIds: [w.h1] });
    await M1().post(`/employees/${w.maria}/pin/reset`);
    await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-10-05' });
    await as(w.tokens.maria).post('/inquiries', { subject: 'Secret subject', body: 'secret body' });
    const rows = await q('SELECT before, after, meta FROM audit_logs');
    expect(rows.length).toBeGreaterThan(5);
    const keys = new Set<string>();
    rows.forEach((r) => collectKeys(r, keys));
    for (const k of PII) expect(keys.has(k)).toBe(false);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/Secret|secret@x|Jonathan|newmanager@x/);
    await expect(getPool().query('UPDATE audit_logs SET action = $1', ['tampered'])).rejects.toThrow(/append-only/);
    await expect(getPool().query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    const api = await M1().get(`/audit-logs?hotelId=${w.h1}&entityType=schedule`);
    expect(api.status).toBe(200);
    expect(api.body.data[0]).toMatchObject({ action: 'schedule.create', entityType: 'schedule' });
    expect((await as(w.tokens.maria).get('/audit-logs')).status).toBe(403);
    expect((await M1().get(`/audit-logs?hotelId=${w.h2}`)).status).toBe(404);
  });

  it('#63 overview: only accessible hotels', async () => {
    const regional = await as(w.tokens.regional).get('/analytics/overview?from=2026-10-01&to=2026-10-31');
    expect(regional.status).toBe(200);
    expect(regional.body.hotels.map((h: any) => h.hotelId)).toEqual([w.h1, w.h2]);
    const m1 = await M1().get(`/analytics/overview?hotelIds=${w.h1},${w.h2}&from=2026-10-01&to=2026-10-31`);
    expect(m1.body.hotels.map((h: any) => h.hotelId)).toEqual([w.h1]);
    expect((await as(w.tokens.maria).get('/analytics/overview?from=2026-10-01&to=2026-10-31')).status).toBe(403);
  });

  it('#75 floating employee: absences/headcount at home hotel, hours where worked', async () => {
    await M1().post(`/employees/${w.flo}/time-offs`, { type: 'sick_leave', startDate: '2026-09-07', endDate: '2026-09-08' });
    await as(w.tokens.manager2).post('/attendance', { hotelId: w.h2, employeeId: w.flo, clockInAt: '2026-09-10T06:00:00Z', clockOutAt: '2026-09-10T14:00:00Z', breakMinutes: 30, reason: 'x' });
    const h1 = await as(w.tokens.regional).get(`/hotels/${w.h1}/analytics/absences?from=2026-09-01&to=2026-09-30`);
    const h2 = await as(w.tokens.regional).get(`/hotels/${w.h2}/analytics/absences?from=2026-09-01&to=2026-09-30`);
    expect(h1.body.byEmployee.find((e: any) => e.employeeId === w.flo).sickDays).toBe(2);
    expect(h2.body.byEmployee.find((e: any) => e.employeeId === w.flo)).toBeUndefined();
    const ov = await as(w.tokens.regional).get('/analytics/overview?from=2026-09-01&to=2026-09-30');
    const [o1, o2] = ov.body.hotels;
    expect(o1.headcount).toBe(4);
    expect(o2.headcount).toBe(0);
    expect(o1.actualPaidHours).toBe(0);
    expect(o2.actualPaidHours).toBe(7.5);
    const att2 = await as(w.tokens.regional).get(`/hotels/${w.h2}/analytics/attendance?from=2026-09-01&to=2026-09-30`);
    expect(att2.body.byEmployee).toEqual([expect.objectContaining({ employeeId: w.flo, actualPaidHours: 7.5, unscheduledCount: 1 })]);
    const hours = await as(w.tokens.regional).get(`/hotels/${w.h2}/analytics/hours?month=2026-10`);
    expect(hours.body.byEmployee.find((e: any) => e.employeeId === w.flo)).toMatchObject({ isHome: false, targetHours: 0 });
  });
});
