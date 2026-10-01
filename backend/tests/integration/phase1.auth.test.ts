import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { anon, app, as } from '../helpers/api';
import { setupWorld, World, createUser } from '../helpers/fixtures';
import { q, q1 } from '../helpers/db';
import { closePool } from '../../src/db/pool';
import { mailer, MemoryMailer } from '../../src/services/mailer';

const outbox = () => (mailer as MemoryMailer).outbox;
const PW = 'correct-horse-battery';

let w: World;

describe('Phase 1: auth, users, hotels, access', () => {
  beforeAll(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('#1 login correct / wrong password', async () => {
    const ok = await anon.post('/auth/login', { login: 'm1@tripinn.test', password: PW });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.refreshToken).toBeTruthy();
    expect(ok.body.expiresIn).toBe(900);
    expect(ok.body.user).toMatchObject({ role: 'manager', hotelIds: [w.h1] });
    const bad = await anon.post('/auth/login', { login: 'm1@tripinn.test', password: 'wrong-password-123' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await anon.post('/auth/login', { login: 'nobody@tripinn.test', password: 'wrong-password-123' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('#2 ten wrong passwords lock the account', async () => {
    const target = await createUser({ companyId: w.companyId, role: 'manager', email: 'locked@tripinn.test', hotelIds: [w.h1] });
    let last;
    for (let i = 0; i < 10; i++) last = await anon.post('/auth/login', { login: 'locked@tripinn.test', password: 'wrong-password-123' });
    expect(last!.status).toBe(423);
    expect(last!.body.error.code).toBe('ACCOUNT_LOCKED');
    const correct = await anon.post('/auth/login', { login: 'locked@tripinn.test', password: PW });
    expect(correct.status).toBe(423);
    const audit = await q(`SELECT * FROM audit_logs WHERE action = 'auth.account_locked' AND entity_id = $1`, [target]);
    expect(audit.length).toBe(1);
  });

  it('#3 manager of hotel 1 reads a hotel 2 department → 404', async () => {
    const res = await as(w.tokens.manager1).get(`/departments/${w.d4}`);
    expect(res.status).toBe(404);
    const list = await as(w.tokens.manager1).get(`/departments?hotelId=${w.h2}`);
    expect(list.status).toBe(404);
  });

  it('#4 regional manager: hotelId=2 / unknown hotel / no hotelId', async () => {
    const ok = await as(w.tokens.regional).get(`/departments?hotelId=${w.h2}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.map((d: any) => d.id)).toEqual([w.d4]);
    expect(ok.body.meta).toMatchObject({ page: 1, limit: 50, total: 1 });
    const other = await as(w.tokens.regional).get(`/departments?hotelId=999`);
    expect(other.status).toBe(404);
    const none = await as(w.tokens.regional).get(`/departments`);
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('#5 invite → accept → login; reusing the token fails', async () => {
    const created = await as(w.tokens.manager1).post('/users', { email: 'new.hire@tripinn.test', role: 'staff', employeeId: w.mia });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('invited');
    const mail = outbox().find((m) => m.to === 'new.hire@tripinn.test');
    expect(mail).toBeTruthy();
    const token = new URL(created.body.inviteUrl).searchParams.get('token')!;
    expect(mail!.text).toContain(encodeURIComponent(token));
    const accepted = await anon.post('/auth/accept-invite', { token, password: 'a-new-password-1' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.accessToken).toBeTruthy();
    const login = await anon.post('/auth/login', { login: 'new.hire@tripinn.test', password: 'a-new-password-1' });
    expect(login.status).toBe(200);
    const reuse = await anon.post('/auth/accept-invite', { token, password: 'another-password-1' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('TOKEN_INVALID');
  });

  it('#6 forgot-password: known and unknown e-mail answer identically', async () => {
    await createUser({ companyId: w.companyId, role: 'manager', email: 'forgetful@tripinn.test', hotelIds: [w.h1] });
    const before = outbox().length;
    const known = await anon.post('/auth/forgot-password', { email: 'forgetful@tripinn.test' });
    const unknown = await anon.post('/auth/forgot-password', { email: 'ghost@tripinn.test' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(outbox().length).toBe(before + 1);
    const link = outbox()[outbox().length - 1].text.match(/token=([^\s]+)/)![1];
    const reset = await anon.post('/auth/reset-password', { token: decodeURIComponent(link), password: 'brand-new-password' });
    expect(reset.status).toBe(200);
    const login = await anon.post('/auth/login', { login: 'forgetful@tripinn.test', password: 'brand-new-password' });
    expect(login.status).toBe(200);
  });

  it('#7 staff calls POST /schedules → 403', async () => {
    const res = await as(w.tokens.maria).post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-10-05' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('#95 staff without e-mail: hand-over link, set password, login with username', async () => {
    const emp = await q1(`INSERT INTO employees (company_id, first_name, last_name) VALUES ($1,'Kai','Novak') RETURNING id`, [w.companyId]);
    await q(`INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home) VALUES ($1,$2,$3,true)`, [emp.id, w.h1, w.companyId]);
    const u = await as(w.tokens.manager1).post('/users', { username: 'kai.n', role: 'staff', employeeId: emp.id });
    expect(u.status).toBe(201);
    expect(u.body).toMatchObject({ username: 'kai.n', status: 'invited', email: null });
    const inv = await as(w.tokens.manager1).post(`/users/${u.body.id}/invite`, { deliver: 'link' });
    expect(inv.status).toBe(200);
    expect(inv.body.inviteUrl).toMatch(/^https:\/\/app\.example\/accept-invite\?token=/);
    expect(inv.body.expiresAt).toBeTruthy();
    const token = new URL(inv.body.inviteUrl).searchParams.get('token')!;
    expect((await anon.post('/auth/accept-invite', { token, password: 'kai-password-123' })).status).toBe(200);
    const login = await anon.post('/auth/login', { login: 'kai.n', password: 'kai-password-123' });
    expect(login.status).toBe(200);
    expect(login.body.user.username).toBe('kai.n');
  });

  it('#96 duplicate username (any case) / neither e-mail nor username', async () => {
    const emp = await q1(`INSERT INTO employees (company_id, first_name, last_name) VALUES ($1,'Lea','Dup') RETURNING id`, [w.companyId]);
    await q(`INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home) VALUES ($1,$2,$3,true)`, [emp.id, w.h1, w.companyId]);
    const dup = await as(w.tokens.manager1).post('/users', { username: 'JON.S', role: 'staff', employeeId: emp.id });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_RESOURCE');
    const none = await as(w.tokens.manager1).post('/users', { role: 'staff', employeeId: emp.id });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('#97 manager reset link for an e-mail-less account revokes old sessions', async () => {
    const login = await anon.post('/auth/login', { login: 'jon.s', password: PW });
    expect(login.status).toBe(200);
    const oldRefresh = login.body.refreshToken;
    const link = await as(w.tokens.manager1).post(`/users/${w.uJon}/password-reset-link`);
    expect(link.status).toBe(200);
    expect(link.body.resetUrl).toMatch(/reset-password\?token=/);
    const token = new URL(link.body.resetUrl).searchParams.get('token')!;
    expect((await anon.post('/auth/reset-password', { token, password: 'jon-new-password' })).status).toBe(200);
    const refresh = await anon.post('/auth/refresh', { refreshToken: oldRefresh });
    expect(refresh.status).toBe(401);
    const me = await as(login.body.accessToken).get('/auth/me');
    expect(me.status).toBe(401);
    expect((await anon.post('/auth/login', { login: 'jon.s', password: 'jon-new-password' })).status).toBe(200);
    const audit = await q(`SELECT 1 FROM audit_logs WHERE action = 'user.password_reset_link' AND entity_id = $1`, [w.uJon]);
    expect(audit.length).toBe(1);
  });

  it('#98 web login: cookie flags, CSRF and refresh-token reuse detection', async () => {
    const login = await request(app).post('/api/v1/auth/login').set('X-Client', 'web').send({ login: 'flo@tripinn.test', password: PW });
    expect(login.status).toBe(200);
    expect(login.body.refreshToken).toBeUndefined();
    expect(login.body.accessToken).toBeTruthy();
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/^refresh_token=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    const cookiePair = cookie.split(';')[0];
    const noCsrf = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookiePair).set('X-Client', 'web');
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_REJECTED');
    const ok = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookiePair)
      .set('X-Client', 'web')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('Origin', 'http://localhost:5173');
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.refreshToken).toBeUndefined();
    const rotated = (ok.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    expect(rotated).not.toBe(cookiePair);
    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookiePair)
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('Origin', 'http://localhost:5173');
    expect(replay.status).toBe(401);
    const fresh = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', rotated)
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('Origin', 'http://localhost:5173');
    expect(fresh.status).toBe(401); // whole family revoked
  });

  it('#99 list sessions, revoke one, refresh with it fails', async () => {
    const a = await anon.post('/auth/login', { login: 'm2@tripinn.test', password: PW });
    const b = await anon.post('/auth/login', { login: 'm2@tripinn.test', password: PW });
    const list = await as(a.body.accessToken).get('/auth/sessions');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    const current = list.body.find((s: any) => s.current);
    expect(current).toBeTruthy();
    const other = list.body.find((s: any) => !s.current && s.userAgent !== 'vitest');
    expect((await as(a.body.accessToken).delete(`/auth/sessions/${other.id}`)).status).toBe(204);
    const refreshB = await anon.post('/auth/refresh', { refreshToken: b.body.refreshToken });
    expect(refreshB.status).toBe(401);
    const refreshA = await anon.post('/auth/refresh', { refreshToken: a.body.refreshToken });
    expect(refreshA.status).toBe(200);
  });

  it('hotel settings: managers read, admin writes (validated)', async () => {
    const read = await as(w.tokens.manager1).get(`/hotels/${w.h1}/settings`);
    expect(read.status).toBe(200);
    expect(read.body.legal.restPeriodMinHours).toBe(11);
    expect((await as(w.tokens.manager1).put(`/hotels/${w.h1}/settings`, read.body)).status).toBe(403);
    const bad = await as(w.tokens.admin).put(`/hotels/${w.h1}/settings`, { legal: { limitMode: 'monthly' } });
    expect(bad.status).toBe(400);
    const ok = await as(w.tokens.admin).put(`/hotels/${w.h1}/settings`, { ...read.body, roster: { ...read.body.roster, changeNoticeHours: 48 } });
    expect(ok.status).toBe(200);
    expect(ok.body.roster.changeNoticeHours).toBe(48);
    await as(w.tokens.admin).put(`/hotels/${w.h1}/settings`, read.body);
  });

  it('hotel-access change applies immediately (sessions revoked)', async () => {
    const m = await createUser({ companyId: w.companyId, role: 'manager', email: 'temp@tripinn.test', hotelIds: [w.h1] });
    const login = await anon.post('/auth/login', { login: 'temp@tripinn.test', password: PW });
    const res = await as(w.tokens.admin).put(`/users/${m}/hotel-access`, { hotelIds: [w.h1, w.h2] });
    expect(res.status).toBe(200);
    expect(res.body.hotelIds).toEqual([w.h1, w.h2]);
    expect((await anon.post('/auth/refresh', { refreshToken: login.body.refreshToken })).status).toBe(401);
    expect((await as(w.tokens.manager1).put(`/users/${m}/hotel-access`, { hotelIds: [w.h1] })).status).toBe(403);
  });

  it('localised error messages (Accept-Language)', async () => {
    const de = await anon.post('/auth/login', { login: 'x@y.z', password: 'nope-nope-nope' });
    expect(de.body.error.message).toBe('Anmeldename oder Passwort ist falsch.');
    const en = await anon.post('/auth/login', { login: 'x@y.z', password: 'nope-nope-nope' }, { 'Accept-Language': 'en-GB' });
    expect(en.body.error.message).toBe('Login or password is wrong.');
  });
});
