import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { getPool } from '../db/pool';
import { AppError } from '../errors/AppError';
import { authenticate } from '../middleware/auth';
import { RateLimiter } from '../middleware/rateLimit';
import * as auth from '../services/auth';
import { parseBody, zPassword } from '../validators/common';
import { revokeAllSessions } from '../services/tokens';

export const loginLimiter = new RateLimiter(config.LOGIN_RATE_LIMIT, 15 * 60_000);
// public token endpoints: stop mail bombing and token guessing per IP
export const publicLimiter = new RateLimiter(config.NODE_ENV === 'test' ? 100_000 : 20, 15 * 60_000);
const limitPublic = (req: Request, _res: Response, next: (e?: unknown) => void) => (publicLimiter.hit(`pub:${req.path}:${req.ip}`) ? next() : next(new AppError('RATE_LIMITED')));
const COOKIE = 'refresh_token';
const COOKIE_PATH = '/api/v1/auth';

function isWeb(req: Request): boolean {
  return (req.header('x-client') ?? '').toLowerCase() === 'web';
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: config.REFRESH_TTL_DAYS * 86_400_000,
  });
}

/** Browser refresh/logout: X-Requested-With + allowed Origin (section 4). */
function assertCsrf(req: Request): void {
  const usesCookie = !!req.cookies?.[COOKIE] || isWeb(req);
  if (!usesCookie) return;
  const xrw = req.header('x-requested-with');
  const origin = req.header('origin');
  if (xrw !== 'XMLHttpRequest' || !origin || !config.corsOrigins.includes(origin)) throw new AppError('CSRF_REJECTED');
}

function meta(req: Request) {
  return { userAgent: req.header('user-agent') ?? undefined, ip: req.ip, requestId: req.requestId };
}

function sessionResponse(req: Request, res: Response, accessToken: string, refreshToken: string, user: unknown, status = 200) {
  if (isWeb(req)) {
    setRefreshCookie(res, refreshToken);
    return res.status(status).json({ accessToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, user });
  }
  return res.status(status).json({ accessToken, refreshToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, user });
}

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const body = parseBody(z.object({ login: z.string().min(1).max(254), password: z.string().min(1).max(200) }), req);
  if (!loginLimiter.hit(`${req.ip}|${body.login.trim().toLowerCase()}`)) throw new AppError('RATE_LIMITED');
  const { session, user } = await auth.login(getPool(), body, meta(req));
  sessionResponse(req, res, session.accessToken, session.refreshToken, user);
});

authRouter.post('/refresh', async (req, res) => {
  assertCsrf(req);
  const token: string | undefined = req.cookies?.[COOKIE] ?? (isWeb(req) ? undefined : req.body?.refreshToken);
  if (!token || typeof token !== 'string') throw new AppError('UNAUTHENTICATED');
  const out = await auth.refresh(token, meta(req));
  if (req.cookies?.[COOKIE]) {
    setRefreshCookie(res, out.refreshToken);
    return res.json({ accessToken: out.accessToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, user: out.user });
  }
  res.json({ accessToken: out.accessToken, refreshToken: out.refreshToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, user: out.user });
});

authRouter.post('/accept-invite', limitPublic, async (req, res) => {
  const body = parseBody(z.object({ token: z.string().min(10), password: zPassword }), req);
  const { session, user } = await auth.acceptInvite(body.token, body.password, meta(req));
  sessionResponse(req, res, session.accessToken, session.refreshToken, user);
});

authRouter.post('/forgot-password', limitPublic, async (req, res) => {
  const body = parseBody(z.object({ email: z.string().email().max(254) }), req);
  await auth.forgotPassword(getPool(), body.email, req.requestId);
  res.json({ ok: true });
});

authRouter.post('/reset-password', limitPublic, async (req, res) => {
  const body = parseBody(z.object({ token: z.string().min(10), password: zPassword }), req);
  await auth.resetPassword(body.token, body.password, req.requestId);
  res.json({ ok: true });
});

// ---- authenticated ----
authRouter.post('/logout', async (req, res, next) => {
  try {
    assertCsrf(req);
  } catch (e) {
    return next(e);
  }
  next();
}, authenticate, async (req, res) => {
  const token: string | undefined = req.cookies?.[COOKIE] ?? req.body?.refreshToken;
  await auth.logoutByRefreshToken(getPool(), token, req.ctx!.sessionId);
  res.clearCookie(COOKIE, { path: COOKIE_PATH });
  res.status(204).end();
});

authRouter.get('/me', authenticate, async (req, res) => {
  res.json(await auth.userPayload(getPool(), req.ctx!.userId));
});

authRouter.post('/change-password', authenticate, async (req, res) => {
  const body = parseBody(z.object({ currentPassword: z.string().min(1), newPassword: zPassword }), req);
  await auth.changePassword(getPool(), req.ctx!.userId, body.currentPassword, body.newPassword, req.ctx!.sessionId);
  res.json({ ok: true });
});

authRouter.get('/sessions', authenticate, async (req, res) => {
  res.json(await auth.listSessions(getPool(), req.ctx!.userId, req.ctx!.sessionId));
});

authRouter.delete('/sessions/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new AppError('RESOURCE_NOT_FOUND');
  await auth.revokeSession(getPool(), req.ctx!.userId, id);
  res.status(204).end();
});

authRouter.post('/logout-all', authenticate, async (req, res) => {
  await revokeAllSessions(getPool(), req.ctx!.userId);
  res.clearCookie(COOKIE, { path: COOKIE_PATH });
  res.status(204).end();
});
