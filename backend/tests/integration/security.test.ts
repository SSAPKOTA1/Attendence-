import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { as, anon } from '../helpers/api';
import { createUser, setupWorld, token, World } from '../helpers/fixtures';
import { q } from '../helpers/db';
import { closePool } from '../../src/db/pool';

let w: World;

describe('security review hardening', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('a manager who is also an employee cannot approve or edit their own records', async () => {
    const mgrEmp = await q(`INSERT INTO employees (company_id, first_name, last_name) VALUES ($1,'Manny','Both') RETURNING id`, [w.companyId]);
    const id = mgrEmp[0].id;
    await q(`INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home) VALUES ($1,$2,$3,true)`, [id, w.h1, w.companyId]);
    const u = await createUser({ companyId: w.companyId, role: 'manager', email: 'both@tripinn.test', employeeId: id, hotelIds: [w.h1] });
    const tok = await token(u);
    // own absence stays pending even when a manager creates it
    const own = await as(tok).post('/employees/me/time-offs', { type: 'annual_leave', startDate: '2026-11-02', endDate: '2026-11-03' });
    expect(own.status).toBe(201);
    expect(own.body.status).toBe('pending');
    const selfApprove = await as(tok).patch(`/time-offs/${own.body.id}`, { status: 'approved' });
    expect(selfApprove.status).toBe(403);
    // another manager (or admin) can decide it
    expect((await as(w.tokens.manager1).patch(`/time-offs/${own.body.id}`, { status: 'approved' })).status).toBe(200);
    // own time entries
    const manual = await as(tok).post('/attendance', { hotelId: w.h1, employeeId: id, clockInAt: '2026-09-01T06:00:00Z', clockOutAt: '2026-09-01T14:00:00Z', reason: 'x' });
    expect(manual.status).toBe(403);
    expect((await as(w.tokens.manager1).post('/attendance', { hotelId: w.h1, employeeId: id, clockInAt: '2026-09-01T06:00:00Z', clockOutAt: '2026-09-01T14:00:00Z', reason: 'x' })).status).toBe(201);
  });

  it('error responses do not leak database constraint names', async () => {
    const res = await as(w.tokens.manager1).post('/departments', { hotelId: w.h1, name: 'front desk' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toMatch(/uq_|idx_|chk_|constraint/i);
  });

  it('refresh tokens, passwords and PINs are never stored in clear text', async () => {
    const login = await anon.post('/auth/login', { login: 'm1@tripinn.test', password: 'correct-horse-battery' });
    const rt = await q('SELECT token_hash FROM refresh_tokens');
    expect(rt.every((r) => r.token_hash !== login.body.refreshToken && r.token_hash.length === 64)).toBe(true);
    const pw = await q(`SELECT password_hash FROM users WHERE email = 'm1@tripinn.test'`);
    expect(pw[0].password_hash).toMatch(/^\$2[aby]\$/);
    const pin = await as(w.tokens.manager1).post(`/employees/${w.maria}/pin/reset`);
    const stored = await q('SELECT pin_hash FROM employee_pins WHERE employee_id = $1', [w.maria]);
    expect(stored[0].pin_hash).not.toContain(pin.body.pin);
  });

  it('access tokens of revoked sessions and tampered tokens are refused', async () => {
    const login = await anon.post('/auth/login', { login: 'm1@tripinn.test', password: 'correct-horse-battery' });
    expect((await as(login.body.accessToken).get('/auth/me')).status).toBe(200);
    expect((await as(login.body.accessToken + 'x').get('/auth/me')).status).toBe(401);
    const forged = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: '1', role: 'admin' })).toString('base64url') + '.';
    expect((await as(forged).get('/auth/me')).status).toBe(401);
    await as(login.body.accessToken).post('/auth/logout-all');
    expect((await as(login.body.accessToken).get('/auth/me')).status).toBe(401);
  });

  it('cross-tenant ids always answer 404', async () => {
    const other = await q(`INSERT INTO companies (name) VALUES ('Other Co') RETURNING id`);
    const oh = await q(`INSERT INTO hotels (company_id, name) VALUES ($1,'Other Hotel') RETURNING id`, [other[0].id]);
    const od = await q(`INSERT INTO departments (hotel_id, name) VALUES ($1,'X') RETURNING id`, [oh[0].id]);
    for (const url of [`/departments/${od[0].id}`, `/departments?hotelId=${oh[0].id}`, `/hotels/${oh[0].id}/settings`]) {
      expect((await as(w.tokens.admin).get(url)).status).toBe(404);
    }
  });
});
