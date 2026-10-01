import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { Db, maybeOne } from '../db/pool';
import { now } from '../clock';
import { sha256 } from './audit';
import { loadUserAccess } from './access';
import { AppError } from '../errors/AppError';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export async function hashSecret(secret: string): Promise<string> {
  return bcrypt.hash(secret, config.BCRYPT_COST);
}

export async function verifySecret(secret: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(secret, hash);
}

// Must use the SAME cost as real hashes: with a cheaper dummy, "unknown login" answers measurably faster than
// "wrong password" and the login form becomes an account-existence oracle.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', config.BCRYPT_COST);
export const dummyHashRounds = (): number => bcrypt.getRounds(DUMMY_HASH);

/** Spends the time of one real password/PIN check (for unknown accounts, locked/disabled ones, unassigned employees). */
export async function burnTime(secret: string): Promise<void> {
  await bcrypt.compare(secret, DUMMY_HASH);
}

export async function signAccessToken(db: Db, userId: number, sid: string | null): Promise<string> {
  const access = await loadUserAccess(db, userId);
  if (!access) throw new AppError('UNAUTHENTICATED');
  return jwt.sign(
    {
      role: access.role,
      companyId: access.companyId,
      hotelIds: access.hotelIds,
      employeeId: access.employeeId,
      sid,
    },
    config.JWT_SECRET,
    { algorithm: 'HS256', subject: String(userId), expiresIn: config.ACCESS_TOKEN_TTL_SECONDS },
  );
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  familyId: string;
  refreshTokenId: number;
}

/** Starts a new login session (token family). */
export async function issueSession(db: Db, userId: number, meta: { userAgent?: string; ip?: string } = {}): Promise<IssuedSession> {
  const familyId = randomUUID();
  const refreshToken = randomToken();
  const t = now();
  const row = await maybeOne(
    db,
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip, created_at, last_used_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
    [userId, familyId, sha256(refreshToken), new Date(t.getTime() + config.REFRESH_TTL_DAYS * 86_400_000), meta.userAgent ?? null, meta.ip ?? null, t],
  );
  const accessToken = await signAccessToken(db, userId, familyId);
  return { accessToken, refreshToken, familyId, refreshTokenId: row!.id };
}

export async function revokeAllSessions(db: Db, userId: number, exceptFamily?: string | null): Promise<void> {
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = $3 WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR family_id <> $2::uuid)`,
    [userId, exceptFamily ?? null, now()],
  );
}

export async function revokeFamily(db: Db, familyId: string): Promise<void> {
  await db.query('UPDATE refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL', [familyId, now()]);
}

/** Single-use invite / password-reset token; earlier unused tokens of the same purpose are invalidated. */
export async function createUserToken(db: Db, userId: number, purpose: 'invite' | 'password_reset', ttlMs: number): Promise<{ token: string; expiresAt: Date }> {
  const t = now();
  await db.query(`UPDATE user_tokens SET used_at = $3 WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose, t]);
  const token = randomToken();
  const expiresAt = new Date(t.getTime() + ttlMs);
  await db.query(`INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)`, [userId, purpose, sha256(token), expiresAt]);
  return { token, expiresAt };
}

/** Consumes a single-use token or throws TOKEN_INVALID. */
export async function consumeUserToken(db: Db, token: string, purposes: ('invite' | 'password_reset')[]): Promise<{ userId: number; purpose: string }> {
  const row = await maybeOne(
    db,
    `UPDATE user_tokens SET used_at = $3
      WHERE token_hash = $1 AND purpose = ANY($2::text[]) AND used_at IS NULL AND expires_at > $3
      RETURNING user_id, purpose`,
    [sha256(token), purposes, now()],
  );
  if (!row) throw new AppError('TOKEN_INVALID');
  return { userId: row.user_id, purpose: row.purpose };
}

export const INVITE_TTL_MS = 7 * 86_400_000;
export const RESET_TTL_MS = 3_600_000;
