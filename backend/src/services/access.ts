import { Db, maybeOne, rows } from '../db/pool';
import { AppError } from '../errors/AppError';
import { effectiveSettings, HotelSettings } from '../domain/settings';
import { todayIn } from '../domain/dates';
import { now } from '../clock';
import type { AuthContext, Role } from '../types/context';

export interface UserAccess {
  userId: number;
  role: Role;
  companyId: number;
  hotelIds: number[];
  employeeId: number | null;
  preferredLanguage: string;
}

/** Current access set of an active user (null if missing/disabled). */
export async function loadUserAccess(db: Db, userId: number): Promise<UserAccess | null> {
  const u = await maybeOne(
    db,
    `SELECT id, role, company_id, employee_id, status, preferred_language FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!u || u.status !== 'active') return null;
  let hotelIds: number[];
  if (u.role === 'admin') {
    hotelIds = (await rows(db, 'SELECT id FROM hotels WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id', [u.company_id])).map((r) => r.id);
  } else if (u.role === 'manager') {
    hotelIds = (
      await rows(
        db,
        `SELECT a.hotel_id FROM user_hotel_access a JOIN hotels h ON h.id = a.hotel_id AND h.deleted_at IS NULL
          WHERE a.user_id = $1 ORDER BY a.hotel_id`,
        [userId],
      )
    ).map((r) => r.hotel_id);
  } else {
    hotelIds = u.employee_id ? await activeHotelIdsOfEmployee(db, u.employee_id) : [];
  }
  return {
    userId: u.id,
    role: u.role,
    companyId: u.company_id,
    hotelIds,
    employeeId: u.employee_id,
    preferredLanguage: u.preferred_language,
  };
}

export async function activeHotelIdsOfEmployee(db: Db, employeeId: number, onDate?: string): Promise<number[]> {
  const date = onDate ?? todayIn('Europe/Berlin', now());
  return (
    await rows(
      db,
      `SELECT eh.hotel_id FROM employee_hotels eh JOIN hotels h ON h.id = eh.hotel_id AND h.deleted_at IS NULL
        WHERE eh.employee_id = $1 AND (eh.unassigned_on IS NULL OR eh.unassigned_on >= $2::date) ORDER BY eh.hotel_id`,
      [employeeId, date],
    )
  ).map((r) => r.hotel_id);
}

/** Hotel scope (section 4): required when the caller can access more than one hotel; must be in the access set (else 404). */
export function resolveHotelId(ctx: AuthContext, requested: number | undefined | null): number {
  if (requested !== undefined && requested !== null) {
    if (!ctx.hotelIds.includes(Number(requested))) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'hotelId', issue: 'not found' }] });
    return Number(requested);
  }
  if (ctx.hotelIds.length === 1) return ctx.hotelIds[0];
  if (ctx.hotelIds.length === 0) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'hotelId', issue: 'no hotel' }] });
  throw new AppError('VALIDATION_ERROR', { details: [{ field: 'hotelId', issue: 'required when you can access more than one hotel' }] });
}

export function assertHotelAccess(ctx: AuthContext, hotelId: number): void {
  if (!ctx.hotelIds.includes(Number(hotelId))) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'hotelId', issue: 'not found' }] });
}

export interface Hotel {
  id: number;
  companyId: number;
  name: string;
  city: string | null;
  timezone: string;
  holidayRegion: string;
  attendanceLockedUntil: string | null;
  settings: HotelSettings;
  rawSettings: unknown;
  updatedAt: Date;
}

export function mapHotel(r: any): Hotel {
  return {
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    city: r.city,
    timezone: r.timezone,
    holidayRegion: r.holiday_region,
    attendanceLockedUntil: r.attendance_locked_until,
    settings: effectiveSettings(r.settings),
    rawSettings: r.settings,
    updatedAt: r.updated_at,
  };
}

export async function loadHotel(db: Db, hotelId: number, companyId?: number): Promise<Hotel> {
  const r = await maybeOne(db, 'SELECT * FROM hotels WHERE id = $1 AND deleted_at IS NULL', [hotelId]);
  if (!r || (companyId !== undefined && r.company_id !== companyId)) {
    throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'hotelId', issue: 'not found' }] });
  }
  return mapHotel(r);
}

export async function loadHotelsByIds(db: Db, ids: number[]): Promise<Map<number, Hotel>> {
  const list = await rows(db, 'SELECT * FROM hotels WHERE id = ANY($1::bigint[])', [ids]);
  return new Map(list.map((r) => [r.id, mapHotel(r)]));
}

export interface EmployeeAccess {
  employee: any; // raw employees row
  employeeId: number;
  homeHotelId: number | null;
  /** hotels the employee is currently assigned to */
  hotelIds: number[];
  /** every hotel ever assigned (history) */
  allHotelIds: number[];
  isSelf: boolean;
  /** admin, or manager with the home hotel in the access set: master data, absences, PIN */
  isHomeManager: boolean;
  /** self or home manager: may see contact data, rate, absence types */
  fullView: boolean;
}

export function resolveEmployeeIdParam(ctx: AuthContext, param: string | number): number {
  if (param === 'me') {
    if (!ctx.employeeId) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'employeeId', issue: 'no employee linked' }] });
    return ctx.employeeId;
  }
  const id = Number(param);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('RESOURCE_NOT_FOUND');
  return id;
}

/**
 * Employee-scoped access (section 7): staff only themselves; managers employees assigned to one of their hotels;
 * admins the whole company. Anything else is a 404 (no enumeration).
 */
export async function getEmployeeAccess(db: Db, ctx: AuthContext, param: string | number): Promise<EmployeeAccess> {
  const employeeId = resolveEmployeeIdParam(ctx, param);
  const employee = await maybeOne(db, 'SELECT * FROM employees WHERE id = $1 AND deleted_at IS NULL', [employeeId]);
  if (!employee || employee.company_id !== ctx.companyId) throw new AppError('RESOURCE_NOT_FOUND');
  const assignments = await rows(db, 'SELECT * FROM employee_hotels WHERE employee_id = $1', [employeeId]);
  const today = todayIn('Europe/Berlin', now());
  // current assignments: hotels the employee has not been unassigned from (history stays in allHotelIds)
  const hotelIds = assignments.filter((a) => !a.unassigned_on).map((a) => a.hotel_id);
  void today;
  const allHotelIds = assignments.map((a) => a.hotel_id);
  const home = assignments.find((a) => a.is_home);
  const isSelf = ctx.employeeId === employeeId;
  let visible = isSelf;
  if (ctx.role === 'admin') visible = true;
  else if (ctx.role === 'manager') visible = visible || allHotelIds.some((h) => ctx.hotelIds.includes(h));
  if (!visible) throw new AppError('RESOURCE_NOT_FOUND');
  const isHomeManager = ctx.role === 'admin' || (ctx.role === 'manager' && !!home && ctx.hotelIds.includes(home.hotel_id));
  return {
    employee,
    employeeId,
    homeHotelId: home ? home.hotel_id : null,
    hotelIds,
    allHotelIds,
    isSelf,
    isHomeManager,
    fullView: isSelf || isHomeManager,
  };
}

export function requireHomeManager(access: EmployeeAccess): void {
  if (!access.isHomeManager) throw new AppError('FORBIDDEN', { details: [{ issue: "only managers of the employee's home hotel may do this" }] });
}

export function requireManager(ctx: AuthContext): void {
  if (ctx.role === 'staff') throw new AppError('FORBIDDEN');
}

export async function homeHotelOf(db: Db, employeeId: number): Promise<Hotel | null> {
  const r = await maybeOne(
    db,
    `SELECT h.* FROM employee_hotels eh JOIN hotels h ON h.id = eh.hotel_id WHERE eh.employee_id = $1 AND eh.is_home`,
    [employeeId],
  );
  return r ? mapHotel(r) : null;
}
