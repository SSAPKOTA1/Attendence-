import { setNow } from '../../src/clock';
import { issueSession, hashSecret } from '../../src/services/tokens';
import { getPool } from '../../src/db/pool';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { resetDb, q1, q } from './db';

/** Thursday 1 Oct 2026, 08:00 in Frankfurt. */
export const NOW = '2026-10-01T06:00:00Z';

export async function token(userId: number): Promise<string> {
  return (await issueSession(getPool(), userId, { userAgent: 'vitest' })).accessToken;
}

export async function createUser(opts: {
  companyId: number;
  role: 'staff' | 'manager' | 'admin';
  email?: string | null;
  username?: string | null;
  employeeId?: number | null;
  hotelIds?: number[];
  password?: string;
  status?: 'active' | 'invited' | 'disabled';
  firstName?: string;
}): Promise<number> {
  const status = opts.status ?? 'active';
  const hash = status === 'invited' ? null : await hashSecret(opts.password ?? 'correct-horse-battery');
  const u = await q1(
    `INSERT INTO users (company_id, employee_id, email, username, password_hash, role, status, first_name, last_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Test') RETURNING id`,
    [opts.companyId, opts.employeeId ?? null, opts.email ?? null, opts.username ?? null, hash, opts.role, status, opts.firstName ?? opts.role],
  );
  for (const h of opts.hotelIds ?? []) await q('INSERT INTO user_hotel_access (user_id, hotel_id) VALUES ($1,$2)', [u.id, h]);
  return u.id;
}

export async function createEmployee(opts: {
  companyId: number;
  firstName: string;
  lastName: string;
  homeHotelId: number;
  otherHotelIds?: number[];
  departmentIds: number[];
  birthDate?: string | null;
  employmentType?: string;
  workWeekdays?: number[];
  employeeNumber?: string | null;
  email?: string | null;
  hourlyRate?: number | null;
  targets?: Partial<{ week: number; minWeek: number; maxWeek: number; month: number; maxMonth: number; minMonth: number }>;
}): Promise<number> {
  const e = await q1(
    `INSERT INTO employees (company_id, first_name, last_name, email, hourly_rate, work_weekdays, birth_date, employment_type, employee_number, phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'+49 69 1234') RETURNING id`,
    [opts.companyId, opts.firstName, opts.lastName, opts.email ?? null, opts.hourlyRate ?? 15.5, opts.workWeekdays ?? [1, 2, 3, 4, 5], opts.birthDate ?? null,
      opts.employmentType ?? 'full_time', opts.employeeNumber ?? null],
  );
  for (const h of [opts.homeHotelId, ...(opts.otherHotelIds ?? [])]) {
    await q('INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home, assigned_on) VALUES ($1,$2,$3,$4,$5)', [e.id, h, opts.companyId, h === opts.homeHotelId, '2026-01-01']);
  }
  for (const d of opts.departmentIds) {
    await q('INSERT INTO employee_departments (employee_id, department_id, hotel_id) SELECT $1, id, hotel_id FROM departments WHERE id = $2', [e.id, d]);
  }
  const t = opts.targets ?? {};
  await q(
    `INSERT INTO employee_work_targets (employee_id, target_hours_per_week, min_hours_per_week, max_hours_per_week, target_hours_per_month, min_hours_per_month, max_hours_per_month)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.id, t.week ?? 40, t.minWeek ?? 30, t.maxWeek ?? 50, t.month ?? 160, t.minMonth ?? 130, t.maxMonth ?? 220],
  );
  return e.id;
}

export interface World {
  companyId: number;
  h1: number;
  h2: number;
  d1: number; // h1 Front Desk
  d2: number; // h1 Housekeeping
  d3: number; // h1 Kitchen
  d4: number; // h2 Front Desk
  early: number; // h1 d1 06-14 b30
  late: number; // h1 d1 14-22 b30
  night: number; // h1 d1 22-06 b60
  hk: number; // h1 d2 08-16 b30
  breakfast: number; // h1 d1 06-10 b0
  dinner: number; // h1 d1 17-21 b0
  mid: number; // h1 d1 10-18 b30
  early2: number; // h2 d4 06-14 b30
  late2: number; // h2 d4 14-22 b30
  admin: number;
  manager1: number;
  manager2: number;
  regional: number;
  maria: number; // employee h1 d1 (staff login)
  jon: number; // employee h1 d1+d2
  flo: number; // floating h1 (home) + h2, d1 + d4
  mia: number; // 17-year-old apprentice h1 d1
  uMaria: number;
  uJon: number;
  uFlo: number;
  tokens: { admin: string; manager1: string; manager2: string; regional: string; maria: string; jon: string; flo: string };
}

export async function setupWorld(): Promise<World> {
  setNow(NOW);
  await resetDb();
  const c = await q1(`INSERT INTO companies (name) VALUES ('Trip Inn Hotels') RETURNING id`);
  const settings = JSON.stringify(DEFAULT_SETTINGS);
  const h1 = (await q1(`INSERT INTO hotels (company_id, name, city, timezone, holiday_region, settings) VALUES ($1,'Trip Inn Frankfurt','Frankfurt','Europe/Berlin','DE-HE',$2) RETURNING id`, [c.id, settings])).id;
  const h2 = (await q1(`INSERT INTO hotels (company_id, name, city, timezone, holiday_region, settings) VALUES ($1,'Trip Inn Munich','Munich','Europe/Berlin','DE-BY',$2) RETURNING id`, [c.id, settings])).id;
  const dept = async (hotel: number, name: string) => (await q1(`INSERT INTO departments (hotel_id, name, color) VALUES ($1,$2,'#2f62b3') RETURNING id`, [hotel, name])).id;
  const d1 = await dept(h1, 'Front Desk');
  const d2 = await dept(h1, 'Housekeeping');
  const d3 = await dept(h1, 'Kitchen');
  const d4 = await dept(h2, 'Front Desk');
  const shift = async (hotel: number, d: number, name: string, s: string, e: string, b: number) =>
    (await q1(`INSERT INTO shifts (hotel_id, department_id, name, start_time, end_time, break_duration_minutes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [hotel, d, name, s, e, b])).id;
  const early = await shift(h1, d1, 'Early', '06:00', '14:00', 30);
  const late = await shift(h1, d1, 'Late', '14:00', '22:00', 30);
  const night = await shift(h1, d1, 'Night', '22:00', '06:00', 60);
  const hk = await shift(h1, d2, 'Housekeeping', '08:00', '16:00', 30);
  const breakfast = await shift(h1, d1, 'Breakfast', '06:00', '10:00', 0);
  const dinner = await shift(h1, d1, 'Dinner', '17:00', '21:00', 0);
  const mid = await shift(h1, d1, 'Mid', '10:00', '18:00', 30);
  const early2 = await shift(h2, d4, 'Early', '06:00', '14:00', 30);
  const late2 = await shift(h2, d4, 'Late', '14:00', '22:00', 30);
  const admin = await createUser({ companyId: c.id, role: 'admin', email: 'admin@tripinn.test' });
  const manager1 = await createUser({ companyId: c.id, role: 'manager', email: 'm1@tripinn.test', hotelIds: [h1] });
  const manager2 = await createUser({ companyId: c.id, role: 'manager', email: 'm2@tripinn.test', hotelIds: [h2] });
  const regional = await createUser({ companyId: c.id, role: 'manager', email: 'regional@tripinn.test', hotelIds: [h1, h2] });
  const maria = await createEmployee({ companyId: c.id, firstName: 'Maria', lastName: 'Garcia', homeHotelId: h1, departmentIds: [d1], employeeNumber: 'P100', email: 'maria@tripinn.test' });
  const jon = await createEmployee({ companyId: c.id, firstName: 'Jon', lastName: 'Smith', homeHotelId: h1, departmentIds: [d1, d2], employeeNumber: 'P101' });
  const flo = await createEmployee({ companyId: c.id, firstName: 'Flo', lastName: 'Weber', homeHotelId: h1, otherHotelIds: [h2], departmentIds: [d1, d4], employeeNumber: 'P102', email: 'flo@tripinn.test' });
  const mia = await createEmployee({ companyId: c.id, firstName: 'Mia', lastName: 'Klein', homeHotelId: h1, departmentIds: [d1], birthDate: '2009-05-10', employmentType: 'apprentice', employeeNumber: 'P103' });
  const uMaria = await createUser({ companyId: c.id, role: 'staff', email: 'maria@tripinn.test', employeeId: maria, firstName: 'Maria' });
  const uJon = await createUser({ companyId: c.id, role: 'staff', username: 'jon.s', employeeId: jon, firstName: 'Jon' });
  const uFlo = await createUser({ companyId: c.id, role: 'staff', email: 'flo@tripinn.test', employeeId: flo, firstName: 'Flo' });
  return {
    companyId: c.id, h1, h2, d1, d2, d3, d4, early, late, night, hk, breakfast, dinner, mid, early2, late2,
    admin, manager1, manager2, regional, maria, jon, flo, mia, uMaria, uJon, uFlo,
    tokens: {
      admin: await token(admin),
      manager1: await token(manager1),
      manager2: await token(manager2),
      regional: await token(regional),
      maria: await token(uMaria),
      jon: await token(uJon),
      flo: await token(uFlo),
    },
  };
}

/** Updates (deep-merges) hotel settings directly. */
export async function patchSettings(hotelId: number, patch: (s: any) => void) {
  const r = await q1('SELECT settings FROM hotels WHERE id = $1', [hotelId]);
  const s = JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, ...(r.settings ?? {}) }));
  patch(s);
  await q('UPDATE hotels SET settings = $2 WHERE id = $1', [hotelId, JSON.stringify(s)]);
}
