import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from '../errors/AppError';
import { getPool } from '../db/pool';
import { loadUserAccess } from '../services/access';
import type { Role } from '../types/context';
import { RateLimiter } from './rateLimit';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  companyId: number;
  hotelIds: number[];
  employeeId: number | null;
  sid: string | null;
}

const userLimiter = new RateLimiter(config.RATE_LIMIT_USER_PER_MIN, 60_000);
export const resetUserRateLimit = () => userLimiter.reset();

/** Verifies the access JWT and re-reads the user's current access set (disabled users and access changes apply at once). */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) return next(new AppError('UNAUTHENTICATED'));
  let payload: AccessTokenPayload;
  try {
    payload = jwt.verify(header.slice(7), config.JWT_SECRET, { algorithms: ['HS256'] }) as unknown as AccessTokenPayload;
  } catch (err: any) {
    return next(new AppError(err?.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED'));
  }
  // a revoked session (logout, password reset, revoked device) cannot keep using its access token
  const [access, live] = await Promise.all([
    loadUserAccess(getPool(), Number(payload.sub)),
    payload.sid
      ? getPool().query('SELECT 1 FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL LIMIT 1', [payload.sid])
      : Promise.resolve(null),
  ]);
  if (!access) return next(new AppError('UNAUTHENTICATED'));
  if (live && live.rowCount === 0) return next(new AppError('UNAUTHENTICATED'));
  if (!userLimiter.hit(`u:${access.userId}`)) return next(new AppError('RATE_LIMITED'));
  req.ctx = {
    ...access,
    lang: access.preferredLanguage === 'en' ? 'en' : 'de',
    sessionId: payload.sid,
    requestId: req.requestId,
    ip: req.ip,
  };
  next();
}

const rank: Record<Role, number> = { staff: 1, manager: 2, admin: 3 };

export function requireRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.ctx) return next(new AppError('UNAUTHENTICATED'));
    if (rank[req.ctx.role] < rank[min]) return next(new AppError('FORBIDDEN'));
    next();
  };
}
