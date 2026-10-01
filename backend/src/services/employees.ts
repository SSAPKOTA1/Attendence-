import { Db, maybeOne, rows } from '../db/pool';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { ageOn, todayIn } from '../domain/dates';
import { now } from '../clock';
import { audit } from './audit';
import { getEmployeeAccess, EmployeeAccess, requireHomeManager, resolveHotelId } from './access';
import { revokeAllSessions } from './tokens';

export interface EmployeeInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  hourlyRate?: number | null;
  status?: 'active' | 'on_leave' | 'terminated';
  workWeekdays?: number[];
  employeeNumber?: string | null;
  birthDate?: string | null;
  hiredOn?: string | null;
  terminatedOn?: string | null;
  employmentType?: string;
  attendanceRequired?: boolean;
  payType?: 'salary' | 'hourly';
  publicHolidaysOff?: boolean;
  /** with a termination: delete roster entries after the termination date instead of refusing */
  removeFutureEntries?: boolean;
  homeHotelId: number;
  hotelIds?: number[];
  departmentIds?: number[];
}

const today = () => todayIn('Europe/Berlin', now());

type DtoView = { full: boolean; showBirthDate?: boolean };

/** Builds employee DTOs for many employees with two queries (assignments, departments) instead of two per employee. */
async function buildEmployeeDtos(db: Db, list: any[], viewOf: (e: any) => DtoView): Promise<any[]> {
  if (list.length === 0) return [];
  const ids = list.map((e) => e.id);
  const assignmentRows = await rows(
    db,
    `SELECT eh.employee_id, eh.hotel_id, eh.is_home, h.name
       FROM employee_hotels eh JOIN hotels h ON h.id = eh.hotel_id
      WHERE eh.employee_id = ANY($1::bigint[]) AND eh.unassigned_on IS NULL
      ORDER BY eh.is_home DESC, eh.hotel_id`,
    [ids],
  );
  const deptRows = await rows(
    db,
    `SELECT ed.employee_id, d.id, d.name, d.color, d.hotel_id
       FROM employee_departments ed JOIN departments d ON d.id = ed.department_id
      WHERE ed.employee_id = ANY($1::bigint[]) AND d.deleted_at IS NULL
      ORDER BY d.hotel_id, d.name`,
    [ids],
  );
  return list.map((e) => {
    const view = viewOf(e);
    const assignments = assignmentRows.filter((a) => a.employee_id === e.id);
    const hotelIds = assignments.map((a) => a.hotel_id);
    const home = assignments.find((a) => a.is_home);
    const dto: any = {
      id: e.id,
      employeeNumber: e.employee_number,
      firstName: e.first_name,
      lastName: e.last_name,
      status: e.status,
      employmentType: e.employment_type,
      hiredOn: e.hired_on,
      attendanceRequired: e.attendance_required,
      publicHolidaysOff: e.public_holidays_off,
      workWeekdays: e.work_weekdays,
      terminatedOn: e.terminated_on,
      homeHotelId: home ? home.hotel_id : null,
      hotels: assignments.map((a) => ({ id: a.hotel_id, name: a.name, isHome: a.is_home })),
      departments: deptRows
        .filter((d) => d.employee_id === e.id && hotelIds.includes(d.hotel_id))
        .map((d) => ({ id: d.id, name: d.name, color: d.color, hotelId: d.hotel_id })),
      updatedAt: e.updated_at,
    };
    if (view.full) {
      dto.email = e.email;
      dto.phone = e.phone;
      dto.hourlyRate = e.hourly_rate;
      dto.payType = e.pay_type;
      dto.anonymizedAt = e.anonymized_at;
    }
    if (view.showBirthDate ?? view.full) dto.birthDate = e.birth_date;
    return dto;
  });
}

export async function employeeDto(db: Db, e: any, opts: DtoView) {
  return (await buildEmployeeDtos(db, [e], () => opts))[0];
}

export function viewOf(access: EmployeeAccess) {
  return { full: access.fullView, showBirthDate: access.fullView };
}

function validateBirthDate(birthDate: string | null | undefined) {
  if (!birthDate) return;
  if (ageOn(birthDate, today()) < 15) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'birthDate', issue: 'employees must be at least 15 years old' }] });
  }
}

/** Departments cannot be taken away from an employee who still has future roster entries on shifts of that department. */
async function assertDepartmentsNotInUse(db: Db, employeeId: number, newDepartmentIds: number[]) {
  const inUse = await rows(
    db,
    `SELECT DISTINCT sh.department_id FROM schedules s JOIN shifts sh ON sh.id = s.shift_id
      WHERE s.employee_id = $1 AND s.date >= $2::date AND s.entry_type = 'shift' AND NOT (sh.department_id = ANY($3::bigint[]))`,
    [employeeId, today(), newDepartmentIds],
  );
  if (inUse.length > 0) {
    throw new AppError('RESOURCE_IN_USE', {
      details: inUse.map((r) => ({ field: 'departmentIds', issue: `future roster entries exist for department ${r.department_id}`, departmentId: r.department_id })),
    });
  }
}

async function assertDepartments(db: Db, departmentIds: number[], hotelIds: number[]) {
  if (departmentIds.length === 0) return;
  const found = await rows(db, 'SELECT id, hotel_id FROM departments WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL', [departmentIds]);
  for (const id of departmentIds) {
    const d = found.find((f) => f.id === id);
    if (!d || !hotelIds.includes(d.hotel_id)) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'departmentIds', issue: `department ${id} does not belong to the employee's hotels` }] });
    }
  }
}

export async function listEmployees(
  db: Db,
  ctx: AuthContext,
  q: { hotelId?: number; departmentId?: number; status?: string; search?: string; page: number; limit: number },
) {
  const hotelId = resolveHotelId(ctx, q.hotelId);
  const t = today();
  const params: unknown[] = [hotelId, t, q.status ?? null, q.search ? `%${q.search}%` : null, q.departmentId ?? null];
  const where = `e.deleted_at IS NULL AND eh.hotel_id = $1 AND (eh.unassigned_on IS NULL OR eh.unassigned_on >= $2::date)
     AND ($3::text IS NULL OR e.status = $3)
     AND ($4::text IS NULL OR (e.first_name || ' ' || e.last_name) ILIKE $4 OR e.employee_number ILIKE $4)
     AND ($5::bigint IS NULL OR EXISTS (SELECT 1 FROM employee_departments ed WHERE ed.employee_id = e.id AND ed.department_id = $5))`;
  const total = (await maybeOne(db, `SELECT count(*)::int n FROM employees e JOIN employee_hotels eh ON eh.employee_id = e.id WHERE ${where}`, params)).n;
  const list = await rows(
    db,
    `SELECT e.*, eh.is_home AS assignment_is_home FROM employees e JOIN employee_hotels eh ON eh.employee_id = e.id
      WHERE ${where} ORDER BY e.last_name, e.first_name, e.id LIMIT $6 OFFSET $7`,
    [...params, q.limit, (q.page - 1) * q.limit],
  );
  const homes = new Map(
    (await rows(db, 'SELECT employee_id, hotel_id FROM employee_hotels WHERE employee_id = ANY($1::bigint[]) AND is_home', [list.map((e) => e.id)])).map((r) => [r.employee_id, r.hotel_id]),
  );
  // managers of the home hotel (and admins) get the full view, everyone else the reduced one (no rate, no contact data)
  const data = await buildEmployeeDtos(db, list, (e) => ({ full: ctx.role === 'admin' || ctx.hotelIds.includes(homes.get(e.id) as number) }));
  data.forEach((dto, i) => {
    dto.isHome = list[i].assignment_is_home;
  });
  return { data, total };
}

export async function getEmployee(db: Db, ctx: AuthContext, id: string | number) {
  const access = await getEmployeeAccess(db, ctx, id);
  return employeeDto(db, access.employee, viewOf(access));
}

export async function createEmployee(db: Db, ctx: AuthContext, input: EmployeeInput) {
  const hotelIds = [...new Set([...(input.hotelIds ?? []), input.homeHotelId])];
  for (const h of hotelIds) {
    if (!ctx.hotelIds.includes(h)) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'hotelIds', issue: `hotel ${h} not found` }] });
  }
  validateBirthDate(input.birthDate);
  const departmentIds = [...new Set(input.departmentIds ?? [])];
  await assertDepartments(db, departmentIds, hotelIds);
  const status = input.status ?? 'active';
  const terminatedOn = input.terminatedOn ?? (status === 'terminated' ? today() : null);
  const e = await maybeOne(
    db,
    `INSERT INTO employees (company_id, first_name, last_name, email, phone, hourly_rate, status, work_weekdays, terminated_on,
                            employee_number, birth_date, hired_on, employment_type, attendance_required, pay_type, public_holidays_off)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [ctx.companyId, input.firstName, input.lastName, input.email ?? null, input.phone ?? null, input.hourlyRate ?? null, status,
      input.workWeekdays ?? [1, 2, 3, 4, 5], terminatedOn, input.employeeNumber ?? null, input.birthDate ?? null, input.hiredOn ?? null,
      input.employmentType ?? 'full_time', input.attendanceRequired ?? true, input.payType ?? 'salary', input.publicHolidaysOff ?? true],
  );
  const assignedOn = input.hiredOn && input.hiredOn < today() ? input.hiredOn : today();
  for (const h of hotelIds) {
    await db.query(
      'INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home, assigned_on) VALUES ($1,$2,$3,$4,$5)',
      [e.id, h, ctx.companyId, h === input.homeHotelId, assignedOn],
    );
  }
  await insertDepartments(db, e.id, departmentIds);
  await db.query('INSERT INTO employee_work_targets (employee_id) VALUES ($1)', [e.id]);
  await audit(db, ctx, {
    action: 'employee.create', entityType: 'employee', entityId: e.id, hotelId: input.homeHotelId,
    after: { status, workWeekdays: e.work_weekdays, employmentType: e.employment_type, payType: e.pay_type, publicHolidaysOff: e.public_holidays_off, hotelIds, departmentIds },
  });
  return employeeDto(db, e, { full: true });
}

async function insertDepartments(db: Db, employeeId: number, departmentIds: number[]) {
  for (const d of departmentIds) {
    await db.query(
      `INSERT INTO employee_departments (employee_id, department_id, hotel_id)
       SELECT $1, d.id, d.hotel_id FROM departments d WHERE d.id = $2`,
      [employeeId, d],
    );
  }
}

/** Disables the login, revokes sessions and deletes the PIN of a terminated employee (R15). */
export async function deactivateTerminated(db: Db, employeeId: number): Promise<void> {
  const users = await rows(db, `SELECT id FROM users WHERE employee_id = $1 AND deleted_at IS NULL`, [employeeId]);
  for (const u of users) {
    await db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [u.id]);
    await revokeAllSessions(db, u.id);
  }
  await db.query('DELETE FROM employee_pins WHERE employee_id = $1', [employeeId]);
}

export async function updateEmployee(db: Db, ctx: AuthContext, id: string | number, input: Partial<EmployeeInput>) {
  const access = await getEmployeeAccess(db, ctx, id);
  requireHomeManager(access);
  const e = access.employee;
  if (input.birthDate !== undefined) validateBirthDate(input.birthDate);
  if (input.departmentIds) await assertDepartments(db, input.departmentIds, access.hotelIds);
  const status = input.status ?? e.status;
  let terminatedOn = input.terminatedOn === undefined ? e.terminated_on : input.terminatedOn;
  if (status === 'terminated' && !terminatedOn) terminatedOn = today();
  const pick = (k: keyof EmployeeInput, col: string) => (input[k] === undefined ? e[col] : input[k]);
  const updated = await maybeOne(
    db,
    `UPDATE employees SET first_name=$2, last_name=$3, email=$4, phone=$5, hourly_rate=$6, status=$7, work_weekdays=$8,
            terminated_on=$9, employee_number=$10, birth_date=$11, hired_on=$12, employment_type=$13, attendance_required=$14,
            pay_type=$15, public_holidays_off=$16
      WHERE id = $1 RETURNING *`,
    [e.id, pick('firstName', 'first_name'), pick('lastName', 'last_name'), pick('email', 'email'), pick('phone', 'phone'),
      pick('hourlyRate', 'hourly_rate'), status, pick('workWeekdays', 'work_weekdays'), terminatedOn, pick('employeeNumber', 'employee_number'),
      pick('birthDate', 'birth_date'), pick('hiredOn', 'hired_on'), pick('employmentType', 'employment_type'), pick('attendanceRequired', 'attendance_required'),
      pick('payType', 'pay_type'), pick('publicHolidaysOff', 'public_holidays_off')],
  );
  if (input.departmentIds) {
    await assertDepartmentsNotInUse(db, e.id, input.departmentIds);
    await db.query('DELETE FROM employee_departments WHERE employee_id = $1', [e.id]);
    await insertDepartments(db, e.id, [...new Set(input.departmentIds)]);
  }
  if (updated.status === 'terminated' && updated.terminated_on) {
    // roster entries after the last working day would still count as coverage and block publishing
    const future = await rows(
      db,
      'SELECT id, hotel_id, date, status FROM schedules WHERE employee_id = $1 AND date > $2::date ORDER BY date, id',
      [e.id, updated.terminated_on],
    );
    if (future.length > 0) {
      if (!input.removeFutureEntries) {
        throw new AppError('RESOURCE_IN_USE', {
          details: [{ field: 'status', issue: `${future.length} roster entries after the termination date exist; remove them first or send removeFutureEntries: true`, entries: future.length }],
        });
      }
      await db.query('DELETE FROM schedules WHERE id = ANY($1::bigint[])', [future.map((f) => f.id)]);
      for (const f of future) {
        await audit(db, ctx, {
          action: 'schedule.delete', entityType: 'schedule', entityId: f.id, hotelId: f.hotel_id,
          before: { date: f.date, status: f.status }, meta: { cause: 'employee_terminated', employeeId: e.id },
        });
      }
    }
    if (updated.terminated_on <= today()) await deactivateTerminated(db, e.id);
  }
  await audit(db, ctx, {
    action: 'employee.update', entityType: 'employee', entityId: e.id, hotelId: access.homeHotelId,
    before: { status: e.status, workWeekdays: e.work_weekdays, employmentType: e.employment_type, terminatedOn: e.terminated_on, payType: e.pay_type, publicHolidaysOff: e.public_holidays_off },
    after: { status: updated.status, workWeekdays: updated.work_weekdays, employmentType: updated.employment_type, terminatedOn: updated.terminated_on, payType: updated.pay_type, publicHolidaysOff: updated.public_holidays_off, changed: Object.keys(input) },
  });
  return employeeDto(db, updated, { full: true });
}

export async function deleteEmployee(db: Db, ctx: AuthContext, id: string | number) {
  const access = await getEmployeeAccess(db, ctx, id);
  requireHomeManager(access);
  const future = await maybeOne(db, 'SELECT 1 FROM schedules WHERE employee_id = $1 AND date >= $2 LIMIT 1', [access.employeeId, today()]);
  if (future) throw new AppError('RESOURCE_IN_USE', { details: [{ field: 'employeeId', issue: 'future roster entries exist' }] });
  await db.query('UPDATE employees SET deleted_at = now() WHERE id = $1', [access.employeeId]);
  await deactivateTerminated(db, access.employeeId);
  await audit(db, ctx, { action: 'employee.delete', entityType: 'employee', entityId: access.employeeId, hotelId: access.homeHotelId });
}

function targetsDto(employeeId: number, r: any) {
  return {
    employeeId,
    targetHoursPerWeek: r.target_hours_per_week,
    minHoursPerWeek: r.min_hours_per_week,
    maxHoursPerWeek: r.max_hours_per_week,
    targetHoursPerMonth: r.target_hours_per_month,
    minHoursPerMonth: r.min_hours_per_month,
    maxHoursPerMonth: r.max_hours_per_month,
    openingBalanceHours: r.opening_balance_hours,
    balanceStartDate: r.balance_start_date,
  };
}

export async function loadTargets(db: Db, employeeId: number) {
  let r = await maybeOne(db, 'SELECT * FROM employee_work_targets WHERE employee_id = $1', [employeeId]);
  if (!r) r = await maybeOne(db, 'INSERT INTO employee_work_targets (employee_id) VALUES ($1) ON CONFLICT (employee_id) DO UPDATE SET employee_id = EXCLUDED.employee_id RETURNING *', [employeeId]);
  return targetsDto(employeeId, r);
}

export type WorkTargets = Awaited<ReturnType<typeof loadTargets>>;

export async function getTargets(db: Db, ctx: AuthContext, id: string | number) {
  const access = await getEmployeeAccess(db, ctx, id);
  return loadTargets(db, access.employeeId);
}

export async function putTargets(db: Db, ctx: AuthContext, id: string | number, input: Partial<Omit<WorkTargets, 'employeeId'>>) {
  const access = await getEmployeeAccess(db, ctx, id);
  requireHomeManager(access);
  const cur = await loadTargets(db, access.employeeId);
  const next = { ...cur, ...input };
  const r = await maybeOne(
    db,
    `UPDATE employee_work_targets SET target_hours_per_week=$2, min_hours_per_week=$3, max_hours_per_week=$4, target_hours_per_month=$5,
            min_hours_per_month=$6, max_hours_per_month=$7, opening_balance_hours=$8, balance_start_date=$9
      WHERE employee_id = $1 RETURNING *`,
    [access.employeeId, next.targetHoursPerWeek, next.minHoursPerWeek, next.maxHoursPerWeek, next.targetHoursPerMonth,
      next.minHoursPerMonth, next.maxHoursPerMonth, next.openingBalanceHours, next.balanceStartDate],
  );
  await audit(db, ctx, { action: 'employee.targets_update', entityType: 'employee', entityId: access.employeeId, hotelId: access.homeHotelId, before: cur, after: next });
  return targetsDto(access.employeeId, r);
}

/** E12: hotel assignments incl. floating staff. */
export async function putHotels(db: Db, ctx: AuthContext, id: string | number, input: { hotelIds: number[]; homeHotelId: number; departmentIds?: number[] }) {
  const access = await getEmployeeAccess(db, ctx, id);
  const employeeId = access.employeeId;
  const newIds = [...new Set([...input.hotelIds, input.homeHotelId])];
  if (!input.hotelIds.includes(input.homeHotelId)) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'homeHotelId', issue: 'must be one of hotelIds' }] });
  }
  const involved = new Set<number>([...access.hotelIds, ...newIds]);
  if (access.homeHotelId) involved.add(access.homeHotelId);
  if (ctx.role !== 'admin') {
    for (const h of involved) if (!ctx.hotelIds.includes(h)) throw new AppError('FORBIDDEN', { details: [{ issue: 'all involved hotels must be in your access set' }] });
  }
  const hotels = await rows(db, 'SELECT id FROM hotels WHERE id = ANY($1::bigint[]) AND company_id = $2 AND deleted_at IS NULL', [newIds, ctx.companyId]);
  if (hotels.length !== newIds.length) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'hotelIds' }] });
  const t = today();
  const removed = access.hotelIds.filter((h) => !newIds.includes(h));
  for (const h of removed) {
    const future = await maybeOne(db, 'SELECT 1 FROM schedules WHERE employee_id = $1 AND hotel_id = $2 AND date > $3 LIMIT 1', [employeeId, h, t]);
    const open = await maybeOne(db, `SELECT 1 FROM time_entries WHERE employee_id = $1 AND hotel_id = $2 AND status <> 'closed' LIMIT 1`, [employeeId, h]);
    if (future || open) {
      throw new AppError('RESOURCE_IN_USE', { details: [{ field: 'hotelIds', issue: future ? `future roster entries at hotel ${h}` : `open time entry at hotel ${h}`, hotelId: h }] });
    }
  }
  const before = { hotelIds: access.hotelIds, homeHotelId: access.homeHotelId };
  await db.query('UPDATE employee_hotels SET is_home = false WHERE employee_id = $1 AND is_home', [employeeId]);
  for (const h of removed) {
    await db.query(
      'UPDATE employee_hotels SET unassigned_on = GREATEST($3::date, assigned_on) WHERE employee_id = $1 AND hotel_id = $2',
      [employeeId, h, t],
    );
    await db.query('DELETE FROM employee_departments WHERE employee_id = $1 AND hotel_id = $2', [employeeId, h]);
  }
  for (const h of newIds) {
    await db.query(
      `INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home, assigned_on) VALUES ($1,$2,$3,false,$4)
       ON CONFLICT (employee_id, hotel_id) DO UPDATE SET unassigned_on = NULL`,
      [employeeId, h, ctx.companyId, t],
    );
  }
  await db.query('UPDATE employee_hotels SET is_home = true WHERE employee_id = $1 AND hotel_id = $2', [employeeId, input.homeHotelId]);
  if (input.departmentIds) {
    await assertDepartments(db, input.departmentIds, newIds);
    await assertDepartmentsNotInUse(db, employeeId, input.departmentIds);
    await db.query('DELETE FROM employee_departments WHERE employee_id = $1', [employeeId]);
    await insertDepartments(db, employeeId, [...new Set(input.departmentIds)]);
  }
  await audit(db, ctx, { action: 'employee.hotels_update', entityType: 'employee', entityId: employeeId, hotelId: input.homeHotelId, before, after: { hotelIds: newIds, homeHotelId: input.homeHotelId } });
  const fresh = await maybeOne(db, 'SELECT * FROM employees WHERE id = $1', [employeeId]);
  const isHomeManager = ctx.role === 'admin' || ctx.hotelIds.includes(input.homeHotelId);
  return employeeDto(db, fresh, { full: isHomeManager || access.isSelf });
}
