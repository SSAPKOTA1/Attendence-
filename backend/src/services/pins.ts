import { randomInt } from 'node:crypto';
import { Db, maybeOne } from '../db/pool';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { audit } from './audit';
import { getEmployeeAccess, requireHomeManager } from './access';
import { hashSecret, verifySecret } from './tokens';

async function storePin(db: Db, employeeId: number, pin: string) {
  const hash = await hashSecret(pin);
  await db.query(
    `INSERT INTO employee_pins (employee_id, pin_hash, failed_count, locked_until, set_at) VALUES ($1,$2,0,NULL,now())
     ON CONFLICT (employee_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, failed_count = 0, locked_until = NULL, set_at = now()`,
    [employeeId, hash],
  );
}

/** P1: server-generated 6-digit PIN, shown once. */
export async function resetPin(db: Db, ctx: AuthContext, id: string | number) {
  const access = await getEmployeeAccess(db, ctx, id);
  requireHomeManager(access);
  if (access.employee.status === 'terminated') throw new AppError('EMPLOYEE_INACTIVE');
  const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await storePin(db, access.employeeId, pin);
  await audit(db, ctx, { action: 'pin.reset', entityType: 'employee', entityId: access.employeeId, hotelId: access.homeHotelId });
  return { pin };
}

/** P2: the employee sets their own PIN (password confirmation required). */
export async function setOwnPin(db: Db, ctx: AuthContext, currentPassword: string, newPin: string) {
  if (!ctx.employeeId) throw new AppError('RESOURCE_NOT_FOUND');
  const u = await maybeOne(db, 'SELECT password_hash FROM users WHERE id = $1', [ctx.userId]);
  if (!u || !(await verifySecret(currentPassword, u.password_hash))) throw new AppError('INVALID_CREDENTIALS');
  if (/^(\d)\1{5}$/.test(newPin) || ['123456', '654321', '012345'].includes(newPin)) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'newPin', issue: 'PIN is too simple' }] });
  }
  await storePin(db, ctx.employeeId, newPin);
  await audit(db, ctx, { action: 'pin.set_own', entityType: 'employee', entityId: ctx.employeeId });
}

export async function unlockPin(db: Db, ctx: AuthContext, id: string | number) {
  const access = await getEmployeeAccess(db, ctx, id);
  requireHomeManager(access);
  await db.query('UPDATE employee_pins SET failed_count = 0, locked_until = NULL WHERE employee_id = $1', [access.employeeId]);
  await audit(db, ctx, { action: 'pin.unlock', entityType: 'employee', entityId: access.employeeId, hotelId: access.homeHotelId });
}
