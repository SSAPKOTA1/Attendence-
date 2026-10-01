import { Db, maybeOne, rows } from '../db/pool';
import { withTransaction } from '../db/tx';
import { AppError } from '../errors/AppError';
import { now } from '../clock';
import { config } from '../config';
import { audit, sha256 } from './audit';
import { loadUserAccess } from './access';
import {
  burnTime, consumeUserToken, createUserToken, hashSecret, issueSession, revokeAllSessions, revokeFamily,
  RESET_TTL_MS, signAccessToken, verifySecret, randomToken,
} from './tokens';
import { link, mailer } from './mailer';

const MAX_FAILED_LOGINS = 10;
const LOCK_MS = 15 * 60_000;

export interface ClientMeta {
  userAgent?: string;
  ip?: string;
  requestId: string;
}

export async function userPayload(db: Db, userId: number) {
  const u = await maybeOne(db, 'SELECT * FROM users WHERE id = $1', [userId]);
  const access = await loadUserAccess(db, userId);
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    firstName: u.first_name,
    lastName: u.last_name,
    role: u.role,
    hotelIds: access?.hotelIds ?? [],
    employeeId: u.employee_id,
    preferredLanguage: u.preferred_language,
  };
}

async function findUserByLogin(db: Db, login: string) {
  const l = login.trim().toLowerCase();
  return maybeOne(
    db,
    `SELECT * FROM users WHERE deleted_at IS NULL AND (lower(email) = $1 OR username = $1) ORDER BY id LIMIT 1`,
    [l],
  );
}

export async function login(db: Db, input: { login: string; password: string }, meta: ClientMeta) {
  const t = now();
  const user = await findUserByLogin(db, input.login);
  const actx = { userId: user?.id ?? null, companyId: user?.company_id ?? null, requestId: meta.requestId } as any;
  if (!user) {
    await burnTime(input.password);
    await audit(db, actx, { action: 'auth.login_failed', entityType: 'user', meta: { loginHash: sha256(input.login.trim().toLowerCase()), reasonCode: 'unknown_user' } });
    throw new AppError('INVALID_CREDENTIALS');
  }
  if (user.locked_until && new Date(user.locked_until) > t) {
    throw new AppError('ACCOUNT_LOCKED', { extra: { lockedUntil: new Date(user.locked_until).toISOString() } });
  }
  const ok = user.status === 'active' && (await verifySecret(input.password, user.password_hash));
  if (!ok) {
    if (user.status !== 'active') await burnTime(input.password);
    const failed = user.failed_login_count + 1;
    if (failed >= MAX_FAILED_LOGINS) {
      const lockedUntil = new Date(t.getTime() + LOCK_MS);
      await db.query('UPDATE users SET failed_login_count = 0, locked_until = $2 WHERE id = $1', [user.id, lockedUntil]);
      await audit(db, actx, { action: 'auth.account_locked', entityType: 'user', entityId: user.id });
      throw new AppError('ACCOUNT_LOCKED', { extra: { lockedUntil: lockedUntil.toISOString() } });
    }
    await db.query('UPDATE users SET failed_login_count = $2 WHERE id = $1', [user.id, failed]);
    await audit(db, actx, { action: 'auth.login_failed', entityType: 'user', entityId: user.id });
    throw new AppError('INVALID_CREDENTIALS');
  }
  await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1', [user.id, t]);
  const session = await issueSession(db, user.id, meta);
  await audit(db, actx, { action: 'auth.login', entityType: 'user', entityId: user.id });
  return { session, user: await userPayload(db, user.id) };
}

/** Rotates a refresh token; reuse of a rotated token revokes the whole family. */
export async function refresh(refreshToken: string, meta: ClientMeta) {
  const out = await withTransaction(async (db) => {
    const t = now();
    const row = await maybeOne(db, 'SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [sha256(refreshToken)]);
    if (!row) throw new AppError('UNAUTHENTICATED');
    if (row.revoked_at) {
      // reuse of a rotated token: revoke the whole family (committed below, outside this transaction)
      if (row.replaced_by_id) return { reuse: { familyId: row.family_id as string, userId: row.user_id as number, tokenId: row.id as number } };
      throw new AppError('UNAUTHENTICATED');
    }
    if (new Date(row.expires_at) <= t) throw new AppError('TOKEN_EXPIRED');
    const fam = await maybeOne(db, 'SELECT min(created_at) AS started FROM refresh_tokens WHERE family_id = $1', [row.family_id]);
    if (t.getTime() - new Date(fam.started).getTime() > config.REFRESH_ABSOLUTE_DAYS * 86_400_000) {
      await revokeFamily(db, row.family_id);
      return { expired: true as const };
    }
    const access = await loadUserAccess(db, row.user_id);
    if (!access) {
      await revokeFamily(db, row.family_id);
      return { disabled: true as const };
    }
    const next = randomToken();
    const inserted = await maybeOne(
      db,
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip, created_at, last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
      [row.user_id, row.family_id, sha256(next), new Date(t.getTime() + config.REFRESH_TTL_DAYS * 86_400_000), meta.userAgent ?? row.user_agent, meta.ip ?? row.ip, t],
    );
    await db.query('UPDATE refresh_tokens SET revoked_at = $2, replaced_by_id = $3, last_used_at = $2 WHERE id = $1', [row.id, t, inserted.id]);
    const accessToken = await signAccessToken(db, row.user_id, row.family_id);
    return { session: { accessToken, refreshToken: next, user: await userPayload(db, row.user_id) } };
  });
  if ('reuse' in out && out.reuse) {
    await withTransaction(async (db) => {
      await revokeFamily(db, out.reuse.familyId);
      await audit(db, { userId: out.reuse.userId, companyId: null as any, requestId: meta.requestId }, {
        action: 'auth.refresh_reuse_detected', entityType: 'session', entityId: out.reuse.tokenId,
      });
    });
    throw new AppError('UNAUTHENTICATED');
  }
  if ('expired' in out) throw new AppError('TOKEN_EXPIRED');
  if ('disabled' in out) throw new AppError('UNAUTHENTICATED');
  return (out as { session: { accessToken: string; refreshToken: string; user: Awaited<ReturnType<typeof userPayload>> } }).session;
}

export async function logoutByRefreshToken(db: Db, refreshToken: string | undefined, sessionId: string | null) {
  if (refreshToken) {
    const row = await maybeOne(db, 'SELECT family_id FROM refresh_tokens WHERE token_hash = $1', [sha256(refreshToken)]);
    if (row) await revokeFamily(db, row.family_id);
  }
  if (sessionId) await revokeFamily(db, sessionId);
}

export async function listSessions(db: Db, userId: number, currentFamily: string | null) {
  const list = await rows(
    db,
    `SELECT DISTINCT ON (family_id) id, family_id, user_agent, ip, created_at, last_used_at,
            (SELECT min(created_at) FROM refresh_tokens f WHERE f.family_id = r.family_id) AS started
       FROM refresh_tokens r
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
      ORDER BY family_id, created_at DESC`,
    [userId, now()],
  );
  return list
    .map((r) => ({
      id: r.id,
      createdAt: r.started,
      lastUsedAt: r.last_used_at,
      userAgent: r.user_agent,
      ip: r.ip,
      current: r.family_id === currentFamily,
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function revokeSession(db: Db, userId: number, sessionId: number) {
  const row = await maybeOne(db, 'SELECT family_id FROM refresh_tokens WHERE id = $1 AND user_id = $2', [sessionId, userId]);
  if (!row) throw new AppError('RESOURCE_NOT_FOUND');
  await revokeFamily(db, row.family_id);
}

export async function changePassword(db: Db, userId: number, currentPassword: string, newPassword: string, keepFamily: string | null) {
  const u = await maybeOne(db, 'SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!u || !(await verifySecret(currentPassword, u.password_hash))) throw new AppError('INVALID_CREDENTIALS');
  await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await hashSecret(newPassword)]);
  await revokeAllSessions(db, userId, keepFamily);
}

export async function acceptInvite(token: string, password: string, meta: ClientMeta) {
  const passwordHash = await hashSecret(password);
  return withTransaction(async (db) => {
    const { userId } = await consumeUserToken(db, token, ['invite']);
    const u = await maybeOne(db, 'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
    if (!u || u.status === 'disabled') throw new AppError('TOKEN_INVALID');
    await db.query(`UPDATE users SET password_hash = $2, status = 'active', failed_login_count = 0, locked_until = NULL WHERE id = $1`, [userId, passwordHash]);
    await audit(db, { userId, companyId: u.company_id, requestId: meta.requestId }, { action: 'user.accept_invite', entityType: 'user', entityId: userId });
    const session = await issueSession(db, userId, meta);
    return { session, user: await userPayload(db, userId) };
  });
}

/** Always succeeds (no account enumeration). Works only for accounts with an e-mail address. */
export async function forgotPassword(db: Db, email: string, requestId: string) {
  const u = await maybeOne(db, `SELECT * FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL AND status = 'active'`, [email.trim()]);
  if (!u) {
    await burnTime(email);
    return;
  }
  const { token } = await createUserToken(db, u.id, 'password_reset', RESET_TTL_MS);
  await audit(db, { userId: u.id, companyId: u.company_id, requestId }, { action: 'auth.forgot_password', entityType: 'user', entityId: u.id });
  try {
    await mailer.send({ to: u.email, subject: 'Password reset / Passwort zurücksetzen', text: `Reset your password: ${link('reset-password', token)}` });
  } catch {
    /* the response must not differ; a failed mail is logged by the transport */
  }
}

export async function resetPassword(token: string, password: string, requestId: string) {
  const passwordHash = await hashSecret(password);
  await withTransaction(async (db) => {
    const { userId } = await consumeUserToken(db, token, ['password_reset']);
    const u = await maybeOne(db, 'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
    if (!u || u.status === 'disabled') throw new AppError('TOKEN_INVALID');
    await db.query(`UPDATE users SET password_hash = $2, status = 'active', failed_login_count = 0, locked_until = NULL WHERE id = $1`, [userId, passwordHash]);
    await revokeAllSessions(db, userId);
    await audit(db, { userId, companyId: u.company_id, requestId }, { action: 'auth.reset_password', entityType: 'user', entityId: userId });
  });
}
