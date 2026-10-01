/* Load test: npm run loadtest  (uses a throw-away database, default shiftsched_load)
 * Seeds 1 company, 2 hotels, EMPLOYEES employees and a month of roster + attendance, then times the heavy endpoints
 * and runs a concurrent mixed workload. Exit code 1 when a budget is exceeded. */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const DB = process.env.LOAD_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shiftsched_load';
process.env.DATABASE_URL = DB;
process.env.NODE_ENV = 'test';
process.env.MAIL_MODE = 'memory';
process.env.BCRYPT_COST = '4';
process.env.RATE_LIMIT_USER_PER_MIN = '1000000';
process.env.LOGIN_RATE_LIMIT = '1000000';
process.env.JWT_SECRET = 'load-test-secret-load-test-secret-123456';
const EMPLOYEES = Number(process.env.EMPLOYEES ?? 150);

async function main() {
  const { migrate } = await import('./migrate');
  const { getPool, closePool } = await import('../src/db/pool');
  const { createApp } = await import('../src/app');
  const { hashSecret } = await import('../src/services/tokens');
  const { DEFAULT_SETTINGS } = await import('../src/domain/settings');
  await migrate(DB, () => undefined);
  const pool = getPool();
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations'`)).rows.map((r) => `"${r.tablename}"`);
  await pool.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);

  const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
  const c = await one(`INSERT INTO companies (name) VALUES ('Load Co') RETURNING id`);
  const hotel = await one(`INSERT INTO hotels (company_id, name, settings) VALUES ($1,'Load Hotel',$2) RETURNING id`, [c.id, JSON.stringify(DEFAULT_SETTINGS)]);
  const dept = await one(`INSERT INTO departments (hotel_id, name) VALUES ($1,'All') RETURNING id`, [hotel.id]);
  const shifts: number[] = [];
  for (const [n, s, e] of [['Early', '06:00', '14:00'], ['Late', '14:00', '22:00'], ['Mid', '10:00', '18:00']]) {
    shifts.push((await one(`INSERT INTO shifts (hotel_id, department_id, name, start_time, end_time, break_duration_minutes) VALUES ($1,$2,$3,$4,$5,30) RETURNING id`, [hotel.id, dept.id, n, s, e])).id);
  }
  const hash = await hashSecret('load-test-password');
  await pool.query(`INSERT INTO users (company_id, email, password_hash, role, status) VALUES ($1,'admin@load.test',$2,'admin','active')`, [c.id, hash]);
  console.log(`seeding ${EMPLOYEES} employees...`);
  const empIds: number[] = [];
  for (let i = 0; i < EMPLOYEES; i++) {
    const e = await one(`INSERT INTO employees (company_id, first_name, last_name, employee_number) VALUES ($1,$2,$3,$4) RETURNING id`, [c.id, `First${i}`, `Last${i}`, `L${i}`]);
    empIds.push(e.id);
    await pool.query(`INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home, assigned_on) VALUES ($1,$2,$3,true,'2026-01-01')`, [e.id, hotel.id, c.id]);
    await pool.query(`INSERT INTO employee_departments (employee_id, department_id, hotel_id) VALUES ($1,$2,$3)`, [e.id, dept.id, hotel.id]);
    await pool.query(`INSERT INTO employee_work_targets (employee_id) VALUES ($1)`, [e.id]);
  }
  // October 2026: every employee works ~20 weekdays (published), attendance for the first 3 weeks
  const days: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(date);
  }
  console.log(`seeding roster (${empIds.length * days.length} entries)...`);
  for (let i = 0; i < empIds.length; i++) {
    const vals: string[] = [];
    for (const date of days) vals.push(`(${hotel.id},${empIds[i]},'shift',${shifts[i % 3]},'${date}','published',now())`);
    await pool.query(`INSERT INTO schedules (hotel_id, employee_id, entry_type, shift_id, date, status, published_at) VALUES ${vals.join(',')}`);
  }
  await pool.query(
    `INSERT INTO time_entries (hotel_id, employee_id, clock_in_at, clock_out_at, break_minutes, status, source_in, source_out)
     SELECT s.hotel_id, s.employee_id, ((s.date + sh.start_time) AT TIME ZONE 'Europe/Berlin'), ((s.date + sh.start_time) AT TIME ZONE 'Europe/Berlin') + interval '8 hours', 30, 'closed', 'manager', 'manager'
       FROM schedules s JOIN shifts sh ON sh.id = s.shift_id WHERE s.date <= '2026-10-21'`,
  );

  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'admin@load.test', password: 'load-test-password' }) });
  const token = ((await login.json()) as { accessToken: string }).accessToken;
  const get = async (path: string) => {
    const t = process.hrtime.bigint();
    const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const body = await r.text();
    return { status: r.status, ms: Number(process.hrtime.bigint() - t) / 1e6, bytes: body.length };
  };
  const post = async (path: string, payload: unknown) => {
    const t = process.hrtime.bigint();
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    await r.text();
    return { status: r.status, ms: Number(process.hrtime.bigint() - t) / 1e6 };
  };

  const h = hotel.id;
  const budgets: [string, string, number][] = [
    ['employee list (page 100)', `/employees?hotelId=${h}&limit=100`, 1500],
    ['roster month (62 days)', `/schedules?hotelId=${h}&from=2026-10-01&to=2026-10-31`, 2500],
    ['coverage month', `/schedules/coverage?hotelId=${h}&from=2026-10-01&to=2026-10-31`, 1500],
    ['attendance month', `/attendance?hotelId=${h}&from=2026-10-01&to=2026-10-31`, 1500],
    ['payroll export (json)', `/hotels/${h}/payroll-export?month=2026-10&format=json`, 6000],
    ['analytics: absences', `/hotels/${h}/analytics/absences?from=2026-10-01&to=2026-10-31`, 6000],
    ['analytics: hours', `/hotels/${h}/analytics/hours?month=2026-10`, 6000],
    ['analytics: attendance', `/hotels/${h}/analytics/attendance?from=2026-10-01&to=2026-10-31`, 8000],
    ['overview', `/analytics/overview?from=2026-10-01&to=2026-10-31`, 6000],
    ['cover finder', `/schedules/candidates?hotelId=${h}&date=2026-11-02&shiftId=${shifts[0]}`, 8000],
    ['live board', `/attendance/live?hotelId=${h}`, 2000],
    ['planning dashboard', `/hotels/${h}/planning-dashboard`, 2000],
  ];
  let failed = 0;
  console.log('\nsingle requests:');
  for (const [name, path, budget] of budgets) {
    const r = await get(path);
    const ok = r.status === 200 && r.ms <= budget;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} ${String(Math.round(r.ms)).padStart(6)} ms  (budget ${budget})  status ${r.status}  ${Math.round(r.bytes / 1024)} KB`);
  }
  // bulk create 500 entries
  const items = Array.from({ length: 500 }, (_, i) => ({ entryType: 'shift', employeeId: empIds[i % empIds.length], shiftId: shifts[0], date: `2026-11-${String(2 + Math.floor(i / empIds.length) * 1).padStart(2, '0')}` }));
  const bulk = await post('/schedules/bulk', { hotelId: h, mode: 'partial', items });
  const bulkOk = bulk.status === 200 && bulk.ms <= 20000;
  if (!bulkOk) failed++;
  console.log(`${bulkOk ? 'ok  ' : 'FAIL'} ${'bulk create 500'.padEnd(28)} ${String(Math.round(bulk.ms)).padStart(6)} ms  (budget 20000)  status ${bulk.status}`);

  // concurrent mixed workload
  console.log('\nconcurrent workload (40 workers x 25 requests):');
  const mix = [`/schedules?hotelId=${h}&from=2026-10-05&to=2026-10-11`, `/employees?hotelId=${h}&limit=50`, `/attendance/live?hotelId=${h}`, `/shifts?hotelId=${h}`, `/schedules/coverage?hotelId=${h}&from=2026-10-05&to=2026-10-11`];
  const lat: number[] = [];
  const byPath = new Map<string, number[]>();
  let errors = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: 40 }, async (_, wkr) => {
    for (let i = 0; i < 25; i++) {
      const r = await get(mix[(wkr + i) % mix.length]);
      lat.push(r.ms);
      const k = mix[(wkr + i) % mix.length].split('?')[0];
      byPath.set(k, [...(byPath.get(k) ?? []), r.ms]);
      if (r.status !== 200) errors++;
    }
  }));
  lat.sort((a, b) => a - b);
  const secs = (Date.now() - started) / 1000;
  const p = (q: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * q))]);
  console.log(`${lat.length} requests in ${secs.toFixed(1)} s = ${(lat.length / secs).toFixed(0)} req/s, p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, p99 ${p(0.99)} ms, errors ${errors}`);
  for (const [k, v] of byPath) {
    v.sort((a, b) => a - b);
    console.log(`  ${k.padEnd(28)} n=${String(v.length).padStart(4)}  p50 ${String(Math.round(v[Math.floor(v.length / 2)])).padStart(5)} ms  p95 ${String(Math.round(v[Math.floor(v.length * 0.95)])).padStart(5)} ms`);
  }
  if (errors > 0 || p(0.95) > 3000) failed++;

  server.close();
  await closePool();
  void randomUUID;
  if (failed > 0) {
    console.error(`\n${failed} budget(s) exceeded`);
    process.exit(1);
  }
  console.log('\nall budgets met');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
