import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { createEmployee, createUser, setupWorld, World } from '../helpers/fixtures';
import { q, q1 } from '../helpers/db';
import { closePool, getPool } from '../../src/db/pool';
import { disableTerminatedUsers, inquiryRetention, tokenCleanup } from '../../src/services/retention';
import { setNow } from '../../src/clock';

let w: World;

async function terminatedEmployee(terminatedOn: string) {
  const id = await createEmployee({ companyId: w.companyId, firstName: 'Old', lastName: 'Timer', homeHotelId: w.h1, departmentIds: [w.d1], email: 'old@x.de', employeeNumber: `T${terminatedOn}`, birthDate: '1980-01-01' });
  await q(`UPDATE employees SET status = 'terminated', terminated_on = $2 WHERE id = $1`, [id, terminatedOn]);
  await q(`INSERT INTO time_entries (hotel_id, employee_id, clock_in_at, clock_out_at, status, source_in, source_out) VALUES ($1,$2,'2022-03-01T06:00:00Z','2022-03-01T14:00:00Z','closed','manager','manager')`, [w.h1, id]);
  await q(`INSERT INTO schedules (hotel_id, employee_id, entry_type, shift_id, date) VALUES ($1,$2,'shift',$3,'2022-03-01')`, [w.h1, id, w.early]);
  await createUser({ companyId: w.companyId, role: 'staff', email: `old${terminatedOn}@x.de`, employeeId: id, status: 'disabled' });
  return id;
}

describe('Phase 10: anonymisation, retention, jobs', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('#64 anonymise a terminated employee after retention', async () => {
    const id = await terminatedEmployee('2022-06-30');
    const res = await as(w.tokens.admin).post(`/employees/${id}/anonymize`, {});
    expect(res.status).toBe(200);
    expect(res.body.forced).toBe(false);
    const e = await q1('SELECT * FROM employees WHERE id = $1', [id]);
    expect(e).toMatchObject({ first_name: 'Former employee', last_name: `#${id}`, email: null, phone: null, hourly_rate: null, birth_date: null, employee_number: null });
    expect(e.anonymized_at).toBeTruthy();
    expect((await q('SELECT 1 FROM time_entries WHERE employee_id = $1', [id])).length).toBe(1);
    expect((await q('SELECT 1 FROM schedules WHERE employee_id = $1', [id])).length).toBe(1);
    const u = await q1('SELECT email, username, status, password_hash FROM users WHERE employee_id = $1', [id]);
    expect(u).toMatchObject({ email: null, status: 'disabled', password_hash: null });
    expect((await q(`SELECT 1 FROM audit_logs WHERE action = 'employee.anonymize' AND entity_id = $1`, [id])).length).toBe(1);
    expect((await as(w.tokens.manager1).post(`/employees/${id}/anonymize`, {})).status).toBe(403);
  });

  it('#65 before retention: 422 without force, 200 with force + reason', async () => {
    const id = await terminatedEmployee('2025-12-31');
    const res = await as(w.tokens.admin).post(`/employees/${id}/anonymize`, {});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RETENTION_NOT_ELAPSED');
    const forced = await as(w.tokens.admin).post(`/employees/${id}/anonymize`, { force: true, reason: 'GDPR erasure request 2026-17' });
    expect(forced.status).toBe(200);
    expect(forced.body.forced).toBe(true);
    const audit = await q1(`SELECT meta FROM audit_logs WHERE action = 'employee.anonymize' AND entity_id = $1`, [id]);
    expect(audit.meta.forceReason).toBe('GDPR erasure request 2026-17');
    const active = await as(w.tokens.admin).post(`/employees/${w.maria}/anonymize`, {});
    expect(active.status).toBe(422);
  });

  it('daily jobs: terminated users, inquiry retention, token cleanup', async () => {
    await q(`UPDATE employees SET terminated_on = '2026-10-05' WHERE id = $1`, [w.jon]);
    await as(w.tokens.manager1).post(`/employees/${w.jon}/pin/reset`);
    expect(await disableTerminatedUsers(getPool())).toBe(0);
    setNow('2026-10-05T23:00:00Z');
    expect(await disableTerminatedUsers(getPool())).toBe(1);
    expect((await q1('SELECT status FROM users WHERE id = $1', [w.uJon])).status).toBe('disabled');
    expect((await q('SELECT 1 FROM employee_pins WHERE employee_id = $1', [w.jon])).length).toBe(0);
    setNow('2026-10-01T06:00:00Z');
    const i = await as(w.tokens.maria).post('/inquiries', { subject: 'old', body: 'x' });
    await as(w.tokens.maria).patch(`/inquiries/${i.body.id}`, { status: 'closed' });
    setNow('2028-11-01T00:00:00Z');
    expect(await inquiryRetention(getPool())).toBe(1);
    await tokenCleanup(getPool());
    expect((await q('SELECT 1 FROM refresh_tokens')).length).toBe(0);
  });
});
