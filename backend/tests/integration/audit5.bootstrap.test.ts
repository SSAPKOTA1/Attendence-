import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { anon, as } from '../helpers/api';
import { resetDb, q } from '../helpers/db';
import { closePool } from '../../src/db/pool';
import { bootstrap } from '../../scripts/bootstrap';

describe('first-time bootstrap of an empty database', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(() => closePool());

  it('creates company, hotel and an invited admin who sets their own password, then manages everything', async () => {
    const r = await bootstrap({ company: 'Trip Inn Hotels', hotel: 'Trip Inn Frankfurt', email: 'owner@tripinn.example', city: 'Frankfurt' });
    expect(r.inviteUrl).toMatch(/^https:\/\/app\.example\/accept-invite\?token=/);
    expect((await q(`SELECT status, role, password_hash FROM users WHERE id = $1`, [r.adminId]))[0]).toEqual({ status: 'invited', role: 'admin', password_hash: null });
    expect((await anon.post('/auth/login', { login: 'owner@tripinn.example', password: 'whatever-123456' })).status).toBe(401);
    const token = new URL(r.inviteUrl).searchParams.get('token')!;
    const accepted = await anon.post('/auth/accept-invite', { token, password: 'my-own-strong-password' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.user).toMatchObject({ role: 'admin', hotelIds: [r.hotelId] });
    // the new admin can run the whole setup through the API
    const adm = as(accepted.body.accessToken);
    expect((await adm.get(`/hotels/${r.hotelId}/settings`)).body.payroll.datev.product).toBe('lodas');
    const dept = await adm.post('/departments', { hotelId: r.hotelId, name: 'Front Desk' });
    expect(dept.status).toBe(201);
    const shift = await adm.post('/shifts', { hotelId: r.hotelId, departmentId: dept.body.id, name: 'Early', startTime: '06:00', endTime: '14:00', breakDurationMinutes: 30 });
    expect(shift.status).toBe(201);
    const emp = await adm.post('/employees', { firstName: 'First', lastName: 'Employee', payType: 'salary', homeHotelId: r.hotelId, departmentIds: [dept.body.id] });
    expect(emp.status).toBe(201);
    expect((await q(`SELECT 1 FROM audit_logs WHERE action = 'system.bootstrap'`)).length).toBe(1);
  });

  it('refuses a second run and invalid input', async () => {
    await bootstrap({ company: 'A', hotel: 'H', email: 'a@x.de' });
    await expect(bootstrap({ company: 'B', hotel: 'H2', email: 'b@x.de' })).rejects.toThrow(/already contains a company/);
    await resetDb();
    await expect(bootstrap({ company: 'A', hotel: 'H', email: 'not-an-email' })).rejects.toThrow(/valid --email/);
    await expect(bootstrap({ company: '', hotel: 'H', email: 'a@x.de' })).rejects.toThrow(/required/);
    await expect(bootstrap({ company: 'A', hotel: 'H', email: 'a@x.de', timezone: 'Mars/Phobos' })).rejects.toThrow();
    expect((await q('SELECT 1 FROM companies')).length).toBe(0);
  });

  it('concurrent bootstraps create exactly one company', async () => {
    const results = await Promise.allSettled([1, 2, 3].map((i) => bootstrap({ company: `Co${i}`, hotel: 'H', email: `a${i}@x.de` })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await q('SELECT 1 FROM companies')).length).toBe(1);
  });
});
