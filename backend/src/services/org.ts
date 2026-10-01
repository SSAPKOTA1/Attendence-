import { Db, maybeOne, rows } from '../db/pool';
import { AppError } from '../errors/AppError';
import { SettingsSchema } from '../domain/settings';
import type { AuthContext } from '../types/context';
import { todayIn } from '../domain/dates';
import { now } from '../clock';
import { audit } from './audit';
import { loadHotel, mapHotel } from './access';

export function companyDto(r: any) {
  return { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function hotelDto(r: any) {
  const h = mapHotel(r);
  return {
    id: h.id,
    companyId: h.companyId,
    name: h.name,
    city: h.city,
    timezone: h.timezone,
    holidayRegion: h.holidayRegion,
    attendanceLockedUntil: h.attendanceLockedUntil,
    updatedAt: h.updatedAt,
  };
}

export async function listCompanies(db: Db, ctx: AuthContext) {
  return (await rows(db, 'SELECT * FROM companies WHERE id = $1 AND deleted_at IS NULL', [ctx.companyId])).map(companyDto);
}

export async function createCompany(db: Db, ctx: AuthContext, name: string) {
  const r = await maybeOne(db, 'INSERT INTO companies (name) VALUES ($1) RETURNING *', [name]);
  await audit(db, ctx, { action: 'company.create', entityType: 'company', entityId: r.id, companyId: r.id });
  return companyDto(r);
}

export async function updateCompany(db: Db, ctx: AuthContext, id: number, name: string) {
  if (id !== ctx.companyId) throw new AppError('RESOURCE_NOT_FOUND');
  const r = await maybeOne(db, 'UPDATE companies SET name = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id, name]);
  if (!r) throw new AppError('RESOURCE_NOT_FOUND');
  await audit(db, ctx, { action: 'company.update', entityType: 'company', entityId: id });
  return companyDto(r);
}

export async function listHotels(db: Db, ctx: AuthContext) {
  return (await rows(db, 'SELECT * FROM hotels WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL ORDER BY id', [ctx.hotelIds])).map(hotelDto);
}

function assertTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'timezone', issue: 'unknown time zone' }] });
  }
}

export async function createHotel(db: Db, ctx: AuthContext, input: { name: string; city?: string | null; timezone?: string; holidayRegion?: string; settings?: unknown }) {
  const tz = input.timezone ?? 'Europe/Berlin';
  assertTimezone(tz);
  const settings = SettingsSchema.parse(input.settings ?? {});
  const r = await maybeOne(
    db,
    `INSERT INTO hotels (company_id, name, city, timezone, holiday_region, settings) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [ctx.companyId, input.name, input.city ?? null, tz, input.holidayRegion ?? 'DE-HE', JSON.stringify(settings)],
  );
  await audit(db, ctx, { action: 'hotel.create', entityType: 'hotel', entityId: r.id, hotelId: r.id });
  return hotelDto(r);
}

export async function updateHotel(db: Db, ctx: AuthContext, id: number, input: { name?: string; city?: string | null; timezone?: string; holidayRegion?: string }) {
  const h = await loadHotel(db, id, ctx.companyId);
  if (input.timezone) assertTimezone(input.timezone);
  const r = await maybeOne(
    db,
    `UPDATE hotels SET name = $2, city = $3, timezone = $4, holiday_region = $5 WHERE id = $1 RETURNING *`,
    [id, input.name ?? h.name, input.city === undefined ? h.city : input.city, input.timezone ?? h.timezone, input.holidayRegion ?? h.holidayRegion],
  );
  await audit(db, ctx, { action: 'hotel.update', entityType: 'hotel', entityId: id, hotelId: id, after: { timezone: r.timezone, holidayRegion: r.holiday_region } });
  return hotelDto(r);
}

export async function deleteHotel(db: Db, ctx: AuthContext, id: number) {
  await loadHotel(db, id, ctx.companyId);
  const hotel = await loadHotel(db, id, ctx.companyId);
  const inUse = await maybeOne(
    db,
    `SELECT 1 FROM employee_hotels WHERE hotel_id = $1 AND unassigned_on IS NULL
     UNION ALL SELECT 1 FROM schedules WHERE hotel_id = $1 AND date >= $2::date LIMIT 1`,
    [id, todayIn(hotel.timezone, now())],
  );
  if (inUse) throw new AppError('RESOURCE_IN_USE');
  await db.query('UPDATE hotels SET deleted_at = now() WHERE id = $1', [id]);
  await audit(db, ctx, { action: 'hotel.delete', entityType: 'hotel', entityId: id, hotelId: id });
}

export async function getSettings(db: Db, ctx: AuthContext, id: number) {
  if (!ctx.hotelIds.includes(id)) throw new AppError('RESOURCE_NOT_FOUND');
  return (await loadHotel(db, id, ctx.companyId)).settings;
}

export async function putSettings(db: Db, ctx: AuthContext, id: number, body: unknown) {
  const h = await loadHotel(db, id, ctx.companyId);
  const settings = SettingsSchema.parse(body ?? {});
  await db.query('UPDATE hotels SET settings = $2 WHERE id = $1', [id, JSON.stringify(settings)]);
  await audit(db, ctx, { action: 'hotel.settings_update', entityType: 'hotel', entityId: id, hotelId: id, before: h.settings, after: settings });
  return settings;
}
