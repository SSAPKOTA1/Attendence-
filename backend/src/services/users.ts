import { Db, maybeOne, rows } from '../db/pool';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { audit } from './audit';
import { getEmployeeAccess } from './access';
import { createUserToken, INVITE_TTL_MS, RESET_TTL_MS, revokeAllSessions } from './tokens';
import { link, mailer } from './mailer';

async function hotelIdsOfUser(db: Db, u: any): Promise<number[]> {
  if (u.role === 'manager') {
    return (await rows(db, 'SELECT hotel_id FROM user_hotel_access WHERE user_id = $1 ORDER BY hotel_id', [u.id])).map((r) => r.hotel_id);
  }
  if (u.role === 'admin') {
    return (await rows(db, 'SELECT id FROM hotels WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id', [u.company_id])).map((r) => r.id);
  }
  if (!u.employee_id) return [];
  return (
    await rows(db, 'SELECT hotel_id FROM employee_hotels WHERE employee_id = $1 AND unassigned_on IS NULL ORDER BY hotel_id', [u.employee_id])
  ).map((r) => r.hotel_id);
}

export async function userDto(db: Db, u: any) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    firstName: u.first_name,
    lastName: u.last_name,
    role: u.role,
    status: u.status,
    employeeId: u.employee_id,
    hotelIds: await hotelIdsOfUser(db, u),
    preferredLanguage: u.preferred_language,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  };
}

/** Admin: whole company. Manager: staff users whose employee is (or was) assigned to one of the manager's hotels. */
async function loadManagedUser(db: Db, ctx: AuthContext, id: number) {
  const u = await maybeOne(db, 'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!u || u.company_id !== ctx.companyId) throw new AppError('RESOURCE_NOT_FOUND');
  if (ctx.role === 'admin') return u;
  if (u.id === ctx.userId) return u;
  if (u.role !== 'staff' || !u.employee_id) throw new AppError('RESOURCE_NOT_FOUND');
  const ok = await maybeOne(db, 'SELECT 1 FROM employee_hotels WHERE employee_id = $1 AND hotel_id = ANY($2::bigint[])', [u.employee_id, ctx.hotelIds]);
  if (!ok) throw new AppError('RESOURCE_NOT_FOUND');
  return u;
}

export async function listUsers(db: Db, ctx: AuthContext, q: { role?: string; status?: string; page: number; limit: number }) {
  const params: unknown[] = [ctx.companyId, q.role ?? null, q.status ?? null];
  let scope = '';
  if (ctx.role !== 'admin') {
    params.push(ctx.hotelIds);
    scope = `AND (u.id IN (SELECT user_id FROM user_hotel_access WHERE hotel_id = ANY($4::bigint[]))
              OR u.employee_id IN (SELECT employee_id FROM employee_hotels WHERE hotel_id = ANY($4::bigint[])))`;
  }
  const where = `u.company_id = $1 AND u.deleted_at IS NULL AND ($2::text IS NULL OR u.role = $2) AND ($3::text IS NULL OR u.status = $3) ${scope}`;
  const total = (await maybeOne(db, `SELECT count(*)::int AS n FROM users u WHERE ${where}`, params)).n;
  params.push(q.limit, (q.page - 1) * q.limit);
  const n = params.length;
  const list = await rows(db, `SELECT u.* FROM users u WHERE ${where} ORDER BY u.id LIMIT $${n - 1} OFFSET $${n}`, params);
  const data = [];
  for (const u of list) data.push(await userDto(db, u));
  return { data, total };
}

export interface CreateUserInput {
  email?: string | null;
  username?: string | null;
  role: 'staff' | 'manager' | 'admin';
  employeeId?: number | null;
  hotelIds?: number[];
  firstName?: string | null;
  lastName?: string | null;
  preferredLanguage?: 'de' | 'en';
  deliver?: 'email' | 'link';
}

export async function createUser(db: Db, ctx: AuthContext, input: CreateUserInput) {
  const email = input.email ? input.email.trim() : null;
  const username = input.username ? input.username.trim().toLowerCase() : null;
  if (!email && !username) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'email', issue: 'an e-mail address or a username is required' }] });
  }
  if (username && !/^[a-z0-9._]{3,40}$/.test(username)) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'username', issue: '3-40 characters: a-z, 0-9, . and _' }] });
  }
  if (ctx.role === 'manager' && input.role !== 'staff') throw new AppError('FORBIDDEN', { details: [{ issue: 'managers can create staff accounts only' }] });
  if (input.role === 'staff' && !input.employeeId) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'employeeId', issue: 'required for staff' }] });
  let firstName = input.firstName ?? null;
  let lastName = input.lastName ?? null;
  if (input.employeeId) {
    const access = await getEmployeeAccess(db, ctx, input.employeeId);
    firstName = firstName ?? access.employee.first_name;
    lastName = lastName ?? access.employee.last_name;
    const existing = await maybeOne(db, 'SELECT 1 FROM users WHERE employee_id = $1 AND deleted_at IS NULL', [input.employeeId]);
    if (existing) throw new AppError('DUPLICATE_RESOURCE', { details: [{ field: 'employeeId', issue: 'this employee already has a login' }] });
  }
  let hotelIds: number[] = [];
  if (input.role === 'manager') {
    hotelIds = [...new Set(input.hotelIds ?? [])];
    if (hotelIds.length === 0) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'hotelIds', issue: 'a manager needs at least one hotel' }] });
    for (const h of hotelIds) if (!ctx.hotelIds.includes(h)) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'hotelIds' }] });
  }
  const u = await maybeOne(
    db,
    `INSERT INTO users (company_id, employee_id, email, username, preferred_language, role, first_name, last_name, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'invited') RETURNING *`,
    [ctx.companyId, input.employeeId ?? null, email, username, input.preferredLanguage ?? 'de', input.role, firstName, lastName],
  );
  for (const h of hotelIds) await db.query('INSERT INTO user_hotel_access (user_id, hotel_id) VALUES ($1,$2)', [u.id, h]);
  await audit(db, ctx, { action: 'user.create', entityType: 'user', entityId: u.id, after: { role: u.role, employeeId: u.employee_id, hotelIds } });
  const dto: any = await userDto(db, u);
  if (email && input.deliver !== 'link') {
    const inv = await sendInvite(db, u, 'email');
    Object.assign(dto, inv);
  }
  return dto;
}

async function sendInvite(db: Db, u: any, deliver: 'email' | 'link') {
  const { token, expiresAt } = await createUserToken(db, u.id, 'invite', INVITE_TTL_MS);
  const inviteUrl = link('accept-invite', token);
  if (deliver === 'link') return { inviteUrl, expiresAt };
  await mailer.send({ to: u.email, subject: 'Invitation / Einladung', text: `Set your password: ${inviteUrl}` });
  return mailer.exposesLinks ? { sent: true, inviteUrl, expiresAt } : { sent: true, expiresAt };
}

export async function inviteUser(db: Db, ctx: AuthContext, id: number, deliver?: 'email' | 'link') {
  const u = await loadManagedUser(db, ctx, id);
  if (u.status !== 'invited') throw new AppError('INVALID_STATUS_TRANSITION', { details: [{ field: 'status', issue: 'user already activated' }] });
  const mode = deliver ?? (u.email ? 'email' : 'link');
  if (mode === 'email' && !u.email) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'deliver', issue: 'user has no e-mail address' }] });
  const out = await sendInvite(db, u, mode);
  await audit(db, ctx, { action: 'user.invite', entityType: 'user', entityId: u.id, meta: { deliver: mode } });
  return out;
}

export async function passwordResetLink(db: Db, ctx: AuthContext, id: number) {
  const u = await loadManagedUser(db, ctx, id);
  const { token, expiresAt } = await createUserToken(db, u.id, 'password_reset', RESET_TTL_MS);
  await audit(db, ctx, { action: 'user.password_reset_link', entityType: 'user', entityId: u.id });
  return { resetUrl: link('reset-password', token), expiresAt };
}

export async function updateUser(
  db: Db,
  ctx: AuthContext,
  id: number,
  input: { email?: string | null; username?: string | null; firstName?: string | null; lastName?: string | null; role?: 'staff' | 'manager' | 'admin'; status?: 'active' | 'disabled'; preferredLanguage?: 'de' | 'en' },
) {
  const u = await loadManagedUser(db, ctx, id);
  if (input.role && input.role !== u.role && ctx.role !== 'admin') throw new AppError('FORBIDDEN');
  const username = input.username === undefined ? u.username : input.username ? input.username.trim().toLowerCase() : null;
  const email = input.email === undefined ? u.email : input.email ? input.email.trim() : null;
  if (!email && !username) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'email', issue: 'an e-mail address or a username is required' }] });
  if (input.status === 'active' && !u.password_hash) {
    throw new AppError('INVALID_STATUS_TRANSITION', { details: [{ field: 'status', issue: 'user has not accepted the invite yet' }] });
  }
  const status = input.status ?? u.status;
  const updated = await maybeOne(
    db,
    `UPDATE users SET email = $2, username = $3, first_name = $4, last_name = $5, role = $6, status = $7, preferred_language = $8
      WHERE id = $1 RETURNING *`,
    [id, email, username, input.firstName === undefined ? u.first_name : input.firstName, input.lastName === undefined ? u.last_name : input.lastName,
      input.role ?? u.role, status, input.preferredLanguage ?? u.preferred_language],
  );
  if (status === 'disabled' && u.status !== 'disabled') await revokeAllSessions(db, id);
  if (input.role && input.role !== u.role) await revokeAllSessions(db, id);
  await audit(db, ctx, { action: 'user.update', entityType: 'user', entityId: id, before: { role: u.role, status: u.status }, after: { role: updated.role, status: updated.status } });
  return userDto(db, updated);
}

export async function deleteUser(db: Db, ctx: AuthContext, id: number) {
  const u = await loadManagedUser(db, ctx, id);
  if (u.id === ctx.userId) throw new AppError('FORBIDDEN', { details: [{ issue: 'you cannot delete your own account' }] });
  await db.query(`UPDATE users SET deleted_at = now(), status = 'disabled' WHERE id = $1`, [id]);
  await revokeAllSessions(db, id);
  await audit(db, ctx, { action: 'user.delete', entityType: 'user', entityId: id });
}

export async function setHotelAccess(db: Db, ctx: AuthContext, id: number, hotelIds: number[]) {
  const u = await loadManagedUser(db, ctx, id);
  if (u.role !== 'manager') throw new AppError('VALIDATION_ERROR', { details: [{ field: 'role', issue: 'hotel access applies to managers' }] });
  const unique = [...new Set(hotelIds)];
  if (unique.length === 0) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'hotelIds', issue: 'a manager needs at least one hotel' }] });
  for (const h of unique) if (!ctx.hotelIds.includes(h)) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'hotelIds' }] });
  const before = await hotelIdsOfUser(db, u);
  await db.query('DELETE FROM user_hotel_access WHERE user_id = $1', [id]);
  for (const h of unique) await db.query('INSERT INTO user_hotel_access (user_id, hotel_id) VALUES ($1,$2)', [id, h]);
  await revokeAllSessions(db, id);
  await audit(db, ctx, { action: 'user.hotel_access', entityType: 'user', entityId: id, before: { hotelIds: before }, after: { hotelIds: unique } });
  return userDto(db, { ...u });
}
