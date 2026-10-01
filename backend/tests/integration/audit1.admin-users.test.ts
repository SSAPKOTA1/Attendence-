import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { anon, as } from '../helpers/api';
import { createEmployee, createUser, setupWorld, token, World } from '../helpers/fixtures';
import { q } from '../helpers/db';
import { closePool } from '../../src/db/pool';

let w: World;
const ADMIN = () => as(w.tokens.admin);
const M1 = () => as(w.tokens.manager1);
const PW = 'correct-horse-battery';

describe('audit 1: companies, hotels, users, optimistic concurrency', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('companies: admin only, scoped to own company', async () => {
    const list = await ADMIN().get('/companies');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect((await M1().get('/companies')).status).toBe(403);
    const created = await ADMIN().post('/companies', { name: 'New Co' });
    expect(created.status).toBe(201);
    expect((await ADMIN().patch(`/companies/${created.body.id}`, { name: 'Hijack' })).status).toBe(404); // not the admin's company
    const own = await ADMIN().patch(`/companies/${w.companyId}`, { name: 'Trip Inn Group' });
    expect(own.body.name).toBe('Trip Inn Group');
    expect((await ADMIN().post('/companies', { name: '   ' })).status).toBe(400);
  });

  it('hotels: create with defaults, validation, update, delete rules', async () => {
    const bad = await ADMIN().post('/hotels', { name: 'X', timezone: 'Mars/Phobos' });
    expect(bad.status).toBe(400);
    expect((await ADMIN().post('/hotels', { name: 'X', holidayRegion: 'germany' })).status).toBe(400);
    expect((await ADMIN().post('/hotels', { name: 'X', settings: { legal: { limitMode: 'nope' } } })).status).toBe(400);
    const h = await ADMIN().post('/hotels', { name: 'Trip Inn Hamburg', city: 'Hamburg', holidayRegion: 'DE-HH' });
    expect(h.status).toBe(201);
    expect(h.body).toMatchObject({ timezone: 'Europe/Berlin', holidayRegion: 'DE-HH', name: 'Trip Inn Hamburg' });
    const settings = await ADMIN().get(`/hotels/${h.body.id}/settings`);
    expect(settings.body.legal.restPeriodMinHours).toBe(11);
    expect(settings.body.payroll.datev.product).toBe('lodas');
    expect((await ADMIN().patch(`/hotels/${h.body.id}`, { timezone: 'Europe/Vienna', city: null })).body).toMatchObject({ timezone: 'Europe/Vienna', city: null });
    expect((await ADMIN().patch(`/hotels/${h.body.id}`, { timezone: 'Nope/Nope' })).status).toBe(400);
    // managers see only their hotels; other hotels' settings are 404
    expect((await M1().get('/hotels')).body.data.map((x: any) => x.id)).toEqual([w.h1]);
    expect((await M1().get(`/hotels/${w.h2}/settings`)).status).toBe(404);
    expect((await M1().patch(`/hotels/${w.h1}`, { name: 'x' })).status).toBe(403);
    // in-use hotel cannot be deleted; an empty one can, and is gone afterwards
    expect((await ADMIN().delete(`/hotels/${w.h1}`)).status).toBe(409);
    expect((await ADMIN().delete(`/hotels/${h.body.id}`)).status).toBe(204);
    expect((await ADMIN().get(`/hotels/${h.body.id}/settings`)).status).toBe(404);
    expect((await ADMIN().get('/hotels')).body.data.map((x: any) => x.id)).not.toContain(h.body.id);
  });

  it('settings round-trip keeps unknown keys out and applies to behaviour', async () => {
    const cur = (await ADMIN().get(`/hotels/${w.h1}/settings`)).body;
    expect((await ADMIN().put(`/hotels/${w.h1}/settings`, { ...cur, surprise: true })).status).toBe(400);
    expect((await ADMIN().put(`/hotels/${w.h1}/settings`, { ...cur, attendance: { ...cur.attendance, pinMaxAttempts: 0 } })).status).toBe(400);
    expect((await ADMIN().put(`/hotels/${w.h1}/settings`, { ...cur, payroll: { ...cur.payroll, nightFrom: '25:00' } })).status).toBe(400);
    const ok = await ADMIN().put(`/hotels/${w.h1}/settings`, { ...cur, legal: { ...cur.legal, restPeriodMinHours: 7 } });
    expect(ok.status).toBe(200);
    // behaviour follows the setting: an 8 h gap no longer warns
    await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.late, date: '2026-10-05' });
    const r = await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-10-06' });
    expect(r.body.warnings.map((x: any) => x.type)).not.toContain('insufficient_rest_period');
  });

  it('users: creation rules and scoping', async () => {
    // managers may create staff logins only
    expect((await M1().post('/users', { email: 'boss@x.de', role: 'manager', hotelIds: [w.h1] })).status).toBe(403);
    expect((await M1().post('/users', { email: 'boss@x.de', role: 'admin' })).status).toBe(403);
    // staff login needs an employee; an employee has one login at most
    expect((await M1().post('/users', { email: 'nobody@x.de', role: 'staff' })).status).toBe(400);
    expect((await M1().post('/users', { email: 'second@x.de', role: 'staff', employeeId: w.maria })).status).toBe(409);
    // employees of another hotel are invisible
    const otherEmp = await createEmployee({ companyId: w.companyId, firstName: 'Far', lastName: 'Away', homeHotelId: w.h2, departmentIds: [w.d4] });
    expect((await M1().post('/users', { email: 'far@x.de', role: 'staff', employeeId: otherEmp })).status).toBe(404);
    // admin creates a manager; hotel access must exist and be valid
    expect((await ADMIN().post('/users', { email: 'nohotel@x.de', role: 'manager' })).status).toBe(400);
    expect((await ADMIN().post('/users', { email: 'badhotel@x.de', role: 'manager', hotelIds: [9999] })).status).toBe(404);
    const mgr = await ADMIN().post('/users', { email: 'newmgr@x.de', role: 'manager', hotelIds: [w.h1, w.h2] });
    expect(mgr.status).toBe(201);
    expect(mgr.body.hotelIds).toEqual([w.h1, w.h2]);
    // duplicate e-mail (case-insensitive) and bad usernames
    expect((await ADMIN().post('/users', { email: 'NEWMGR@x.de', role: 'manager', hotelIds: [w.h1] })).status).toBe(409);
    expect((await M1().post('/users', { username: 'Bad Name!', role: 'staff', employeeId: otherEmp })).status).toBe(400);
  });

  it('users: list is scoped for managers and paginated', async () => {
    const mgrList = await M1().get('/users');
    expect(mgrList.status).toBe(200);
    const ids = mgrList.body.data.map((u: any) => u.id);
    expect(ids).toContain(w.uMaria);
    expect(ids).not.toContain(w.manager2);
    expect(ids).not.toContain(w.admin);
    const all = await ADMIN().get('/users?limit=3&page=2');
    expect(all.body.meta).toMatchObject({ page: 2, limit: 3, total: 7 });
    expect(all.body.data).toHaveLength(3);
    expect((await ADMIN().get('/users?role=admin')).body.data).toHaveLength(1);
    expect((await ADMIN().get('/users?limit=500')).status).toBe(400);
    expect((await as(w.tokens.maria).get('/users')).status).toBe(403);
  });

  it('users: disable/enable, delete, own-account protection', async () => {
    const login = await anon.post('/auth/login', { login: 'flo@tripinn.test', password: PW });
    expect((await M1().patch(`/users/${w.uFlo}`, { status: 'disabled' })).status).toBe(200);
    expect((await anon.post('/auth/login', { login: 'flo@tripinn.test', password: PW })).status).toBe(401);
    expect((await anon.post('/auth/refresh', { refreshToken: login.body.refreshToken })).status).toBe(401);
    expect((await as(login.body.accessToken).get('/auth/me')).status).toBe(401);
    expect((await M1().patch(`/users/${w.uFlo}`, { status: 'active' })).status).toBe(200);
    expect((await anon.post('/auth/login', { login: 'flo@tripinn.test', password: PW })).status).toBe(200);
    // an invited user without a password cannot be activated by hand
    const inv = await M1().post('/users', { email: 'inv@x.de', role: 'staff', employeeId: w.mia });
    expect((await M1().patch(`/users/${inv.body.id}`, { status: 'active' })).status).toBe(422);
    // deleting: not yourself, and the e-mail becomes reusable
    expect((await M1().delete(`/users/${w.manager1}`)).status).toBe(403);
    expect((await M1().delete(`/users/${inv.body.id}`)).status).toBe(204);
    expect((await M1().post('/users', { email: 'inv@x.de', role: 'staff', employeeId: w.mia })).status).toBe(201);
    // a manager cannot touch a manager or admin account, nor escalate roles
    expect((await M1().patch(`/users/${w.admin}`, { status: 'disabled' })).status).toBe(404);
    expect((await M1().patch(`/users/${w.manager2}`, { status: 'disabled' })).status).toBe(404);
    expect((await M1().patch(`/users/${w.manager1}`, { role: 'admin' })).status).toBe(403);
    expect((await M1().patch(`/users/${w.uMaria}`, { role: 'manager' })).status).toBe(403);
  });

  it('invites: cannot be sent to activated users; link delivery needs no e-mail; old tokens die', async () => {
    expect((await M1().post(`/users/${w.uMaria}/invite`, { deliver: 'link' })).status).toBe(422);
    const emp = await createEmployee({ companyId: w.companyId, firstName: 'Nom', lastName: 'Ail', homeHotelId: w.h1, departmentIds: [w.d1] });
    const u = await M1().post('/users', { username: 'nom.ail', role: 'staff', employeeId: emp });
    expect((await M1().post(`/users/${u.body.id}/invite`, { deliver: 'email' })).status).toBe(400);
    const first = await M1().post(`/users/${u.body.id}/invite`, { deliver: 'link' });
    const second = await M1().post(`/users/${u.body.id}/invite`, { deliver: 'link' });
    const t1 = new URL(first.body.inviteUrl).searchParams.get('token')!;
    const t2 = new URL(second.body.inviteUrl).searchParams.get('token')!;
    expect((await anon.post('/auth/accept-invite', { token: t1, password: 'a-valid-password-1' })).status).toBe(400); // superseded
    expect((await anon.post('/auth/accept-invite', { token: t2, password: 'short' })).status).toBe(400); // password rule
    expect((await anon.post('/auth/accept-invite', { token: t2, password: 'a-valid-password-1' })).status).toBe(200);
    // expired token
    const third = await M1().post(`/users/${w.uJon}/password-reset-link`);
    const t3 = new URL(third.body.resetUrl).searchParams.get('token')!;
    await q(`UPDATE user_tokens SET expires_at = '2026-09-01T00:00:00Z'`);
    expect((await anon.post('/auth/reset-password', { token: t3, password: 'a-valid-password-1' })).status).toBe(400);
  });

  it('change-password revokes other sessions and keeps the current one', async () => {
    const a = await anon.post('/auth/login', { login: 'm2@tripinn.test', password: PW });
    const b = await anon.post('/auth/login', { login: 'm2@tripinn.test', password: PW });
    expect((await as(a.body.accessToken).post('/auth/change-password', { currentPassword: 'wrong-password-1', newPassword: 'another-password-1' })).status).toBe(401);
    expect((await as(a.body.accessToken).post('/auth/change-password', { currentPassword: PW, newPassword: 'another-password-1' })).status).toBe(200);
    expect((await as(a.body.accessToken).get('/auth/me')).status).toBe(200);
    expect((await as(b.body.accessToken).get('/auth/me')).status).toBe(401);
    expect((await anon.post('/auth/login', { login: 'm2@tripinn.test', password: PW })).status).toBe(401);
    expect((await anon.post('/auth/login', { login: 'm2@tripinn.test', password: 'another-password-1' })).status).toBe(200);
  });

  it('If-Match: stale writes → 412 on schedules, time-offs, attendance and corrections', async () => {
    const s = await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-10-05' });
    const got = await M1().get(`/schedules/${s.body.id}`);
    expect(got.headers.etag).toMatch(/^W\/"\d+"$/);
    expect((await M1().patch(`/schedules/${s.body.id}`, { shiftId: w.late }, { 'If-Match': got.headers.etag })).status).toBe(200);
    const stale = await M1().patch(`/schedules/${s.body.id}`, { shiftId: w.early }, { 'If-Match': got.headers.etag });
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe('PRECONDITION_FAILED');
    expect((await M1().patch(`/schedules/${s.body.id}`, { shiftId: w.early })).status).toBe(200); // no header: last write wins

    const t = await as(w.tokens.maria).post('/employees/me/time-offs', { type: 'unpaid_leave', startDate: '2026-12-01', endDate: '2026-12-01' });
    const tg = await as(w.tokens.maria).get(`/time-offs/${t.body.id}`);
    await M1().patch(`/time-offs/${t.body.id}`, { medicalCertificateReceived: undefined, status: 'approved' });
    expect((await M1().patch(`/time-offs/${t.body.id}`, { status: 'cancelled' }, { 'If-Match': tg.headers.etag })).status).toBe(412);

    const e = await M1().post('/attendance', { hotelId: w.h1, employeeId: w.maria, clockInAt: '2026-09-07T06:00:00Z', clockOutAt: '2026-09-07T14:00:00Z', reason: 'x' });
    const eg = await M1().get(`/attendance/${e.body.id}`);
    expect((await M1().patch(`/attendance/${e.body.id}`, { breakMinutes: 30, reason: 'r' }, { 'If-Match': eg.headers.etag })).status).toBe(200);
    expect((await M1().patch(`/attendance/${e.body.id}`, { breakMinutes: 20, reason: 'r' }, { 'If-Match': eg.headers.etag })).status).toBe(412);
  });

  it('malformed input never produces a 500', async () => {
    const t = w.tokens.manager1;
    const cases: [string, string, unknown][] = [
      ['post', '/schedules', { employeeId: 'abc', date: 'not-a-date' }],
      ['post', '/schedules', { employeeId: 1, shiftId: 1, date: '2026-02-30' }],
      ['post', '/schedules/bulk', { items: [] }],
      ['post', '/schedules/bulk', { items: 'x' }],
      ['post', '/time-offs/preview', { employeeId: -1, type: 'nope' }],
      ['post', '/employees', { firstName: '', payType: 'salary' }],
      ['patch', '/schedules/abc', {}],
      ['patch', '/schedules/99999999999999999999', {}],
      ['get', '/schedules?from=2026-10-05', undefined],
      ['get', '/schedules?from=2026-10-05&to=2026-10-01', undefined],
      ['get', '/employees?limit=-5', undefined],
      ['get', '/employees/0', undefined],
      ['get', '/attendance?from=x&to=y', undefined],
      ['put', '/shifts/1/staffing-requirements', { requirements: [{ weekday: 9, minStaff: 1 }] }],
    ];
    for (const [m, url, body] of cases) {
      const res = await (as(t) as any)[m](url, ...(body === undefined ? [] : [body]));
      expect(res.status, `${m} ${url}`).toBeLessThan(500);
      expect(res.status, `${m} ${url}`).toBeGreaterThanOrEqual(400);
      expect(res.body.error.code).toBeTruthy();
    }
    const badJson = await (await import('supertest')).default((await import('../helpers/api')).app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"login": ');
    expect(badJson.status).toBe(400);
    const huge = await (await import('supertest')).default((await import('../helpers/api')).app).post('/api/v1/auth/login').send({ login: 'x'.repeat(200_000), password: 'y' });
    expect(huge.status).toBeLessThan(500);
    void token; void createUser;
  });
});
