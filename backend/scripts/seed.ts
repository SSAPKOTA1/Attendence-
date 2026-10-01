/* Demo data (spec section 9). Never in production. Usage: npm run seed [-- --reset] */
import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { config } from '../src/config';
import { closePool, getPool } from '../src/db/pool';
import { withTransaction } from '../src/db/tx';
import { DEFAULT_SETTINGS } from '../src/domain/settings';
import { hashSecret, randomToken } from '../src/services/tokens';
import { sha256 } from '../src/services/audit';

const PASSWORD = 'Demo-Password-2026';

async function main() {
  if (config.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
  const pool = getPool();
  const existing = await pool.query('SELECT count(*)::int n FROM companies');
  if (existing.rows[0].n > 0) {
    if (!process.argv.includes('--reset')) {
      console.log('Database already contains data. Run with --reset to wipe and reseed.');
      return;
    }
    const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations'`)).rows.map((r) => `"${r.tablename}"`);
    await pool.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  }
  const pw = await hashSecret(PASSWORD);
  const out = await withTransaction(async (db) => {
    const one = async (sql: string, params: unknown[]) => (await db.query(sql, params as any[])).rows[0];
    const company = await one(`INSERT INTO companies (name) VALUES ('Trip Inn Hotels') RETURNING id`, []);
    const settings = JSON.stringify(DEFAULT_SETTINGS);
    const fra = await one(`INSERT INTO hotels (company_id, name, city, timezone, holiday_region, settings) VALUES ($1,'Trip Inn Frankfurt','Frankfurt am Main','Europe/Berlin','DE-HE',$2) RETURNING id`, [company.id, settings]);
    const ber = await one(`INSERT INTO hotels (company_id, name, city, timezone, holiday_region, settings) VALUES ($1,'Trip Inn Berlin','Berlin','Europe/Berlin','DE-BE',$2) RETURNING id`, [company.id, settings]);
    const dept = async (hotel: number, name: string, color: string) => (await one('INSERT INTO departments (hotel_id, name, color) VALUES ($1,$2,$3) RETURNING id', [hotel, name, color])).id;
    const frontDesk = await dept(fra.id, 'Front Desk', '#2f62b3');
    const housekeeping = await dept(fra.id, 'Housekeeping', '#3a9d5d');
    const breakfast = await dept(fra.id, 'Breakfast', '#d08a1f');
    const berFront = await dept(ber.id, 'Front Desk', '#2f62b3');
    const shift = async (hotel: number, d: number, name: string, s: string, e: string, b: number) =>
      (await one('INSERT INTO shifts (hotel_id, department_id, name, start_time, end_time, break_duration_minutes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [hotel, d, name, s, e, b])).id;
    await shift(fra.id, frontDesk, 'Early', '06:00', '14:00', 30);
    await shift(fra.id, frontDesk, 'Late', '14:00', '22:00', 30);
    await shift(fra.id, frontDesk, 'Night', '22:00', '06:00', 60);
    await shift(fra.id, housekeeping, 'Housekeeping', '08:00', '16:30', 30);
    await shift(fra.id, breakfast, 'Breakfast', '06:00', '10:30', 0);
    await shift(ber.id, berFront, 'Early', '06:00', '14:00', 30);

    const user = async (role: string, email: string | null, username: string | null, first: string, last: string, employeeId: number | null, hotels: number[] = []) => {
      const u = await one(
        `INSERT INTO users (company_id, employee_id, email, username, password_hash, role, status, first_name, last_name) VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8) RETURNING id`,
        [company.id, employeeId, email, username, pw, role, first, last],
      );
      for (const h of hotels) await db.query('INSERT INTO user_hotel_access (user_id, hotel_id) VALUES ($1,$2)', [u.id, h]);
      return u.id;
    };
    await user('admin', 'admin@tripinn.example', null, 'Ada', 'Admin', null);
    await user('manager', 'manager.frankfurt@tripinn.example', null, 'Frank', 'Manager', null, [fra.id]);
    await user('manager', 'regional@tripinn.example', null, 'Regina', 'Regional', null, [fra.id, ber.id]);

    const pins: { name: string; login: string; pin: string }[] = [];
    const employee = async (
      first: string, last: string, number: string, depts: number[], opts: { email?: string; username?: string; birthDate?: string; type?: string; floating?: boolean; payType?: 'salary' | 'hourly'; holidaysOff?: boolean },
    ) => {
      const e = await one(
        `INSERT INTO employees (company_id, first_name, last_name, email, hourly_rate, employee_number, birth_date, employment_type, hired_on, pay_type, public_holidays_off)
         VALUES ($1,$2,$3,$4,15.50,$5,$6,$7,'2025-01-01',$8,$9) RETURNING id`,
        [company.id, first, last, opts.email ?? null, number, opts.birthDate ?? null, opts.type ?? 'full_time', opts.payType ?? 'salary', opts.holidaysOff ?? true],
      );
      await db.query('INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home, assigned_on) VALUES ($1,$2,$3,true,$4)', [e.id, fra.id, company.id, '2025-01-01']);
      if (opts.floating) await db.query('INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home, assigned_on) VALUES ($1,$2,$3,false,$4)', [e.id, ber.id, company.id, '2025-01-01']);
      for (const d of depts) await db.query('INSERT INTO employee_departments (employee_id, department_id, hotel_id) SELECT $1, id, hotel_id FROM departments WHERE id = $2', [e.id, d]);
      await db.query('INSERT INTO employee_work_targets (employee_id) VALUES ($1)', [e.id]);
      await user('staff', opts.email ?? null, opts.username ?? null, first, last, e.id);
      const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await db.query('INSERT INTO employee_pins (employee_id, pin_hash) VALUES ($1,$2)', [e.id, await hashSecret(pin)]);
      pins.push({ name: `${first} ${last}`, login: opts.email ?? opts.username!, pin });
      return e.id;
    };
    await employee('Maria', 'Garcia', 'P100', [frontDesk], { email: 'maria@tripinn.example' });
    await employee('Jonas', 'Schmidt', 'P101', [frontDesk, housekeeping], { email: 'jonas@tripinn.example' });
    await employee('Flo', 'Weber', 'P102', [frontDesk, berFront], { email: 'flo@tripinn.example', floating: true });
    await employee('Mia', 'Klein', 'P103', [breakfast], { email: 'mia@tripinn.example', birthDate: new Date(Date.now() - 17.3 * 365.25 * 86_400_000).toISOString().slice(0, 10), type: 'apprentice' });
    await employee('Kai', 'Novak', 'P104', [housekeeping], { username: 'kai.novak', payType: 'hourly', holidaysOff: false });
    await employee('Lena', 'Brandt', 'P105', [breakfast, frontDesk], { email: 'lena@tripinn.example', type: 'part_time', payType: 'hourly' });

    const deviceToken = randomToken(32);
    await db.query(`INSERT INTO kiosk_devices (hotel_id, name, token_hash) VALUES ($1,'Front desk tablet (demo)',$2)`, [fra.id, sha256(deviceToken)]);
    return { pins, deviceToken };
  });
  console.log('Seeded demo data.');
  console.log(`Password for every account: ${PASSWORD}`);
  console.log('Logins: admin@tripinn.example, manager.frankfurt@tripinn.example, regional@tripinn.example');
  console.table(out.pins);
  console.log(`Demo kiosk device token (X-Device-Token): ${out.deviceToken}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
