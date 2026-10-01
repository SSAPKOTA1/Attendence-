import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { getPool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { RateLimiter } from '../middleware/rateLimit';
import { AppError } from '../errors/AppError';
import * as kiosk from '../services/kiosk';
import { idParam, parseBody, parseQuery, zOptId } from '../validators/common';

export const kioskRouter = Router();
export const kioskLimiter = new RateLimiter(config.KIOSK_RATE_LIMIT, 60_000);

async function deviceAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    req.device = await kiosk.authenticateDevice(getPool(), req.header('x-device-token') ?? undefined, req.ip);
    if (!kioskLimiter.hit(`d:${req.device.deviceId}`)) throw new AppError('RATE_LIMITED');
    next();
  } catch (err) {
    next(err);
  }
}

// ---- public: pairing ----
kioskRouter.post('/pair', async (req, res) => {
  const body = parseBody(z.object({ pairingCode: z.string().min(4).max(20) }), req);
  res.json(await kiosk.pairDevice(body.pairingCode, req.requestId));
});

// ---- device token ----
kioskRouter.get('/roster', deviceAuth, async (req, res) => {
  const q = parseQuery(z.object({ search: z.string().max(60).optional() }), req);
  res.json(await kiosk.kioskRoster(getPool(), req.device!, q.search));
});

kioskRouter.post('/verify', deviceAuth, async (req, res) => {
  const body = parseBody(z.object({ employeeId: z.number().int().positive(), pin: z.string().regex(/^\d{6}$/, '6 digits') }), req);
  res.json(await kiosk.verifyPin(req.device!, body.employeeId, body.pin, req.requestId));
});

kioskRouter.post('/punch', deviceAuth, async (req, res) => {
  // any time sent by the tablet is ignored: only punchToken and action are read (R13.3)
  const body = parseBody(z.object({ punchToken: z.string().min(10).max(200), action: z.enum(['clock_in', 'clock_out', 'break_start', 'break_end']) }), req);
  res.status(201).json(await kiosk.punch(req.device!, body.punchToken, body.action, req.requestId));
});

// ---- manager session ----
kioskRouter.post('/pairing-codes', authenticate, requireRole('manager'), async (req, res) => {
  const body = parseBody(z.object({ hotelId: z.number().int().positive().optional(), deviceName: z.string().trim().min(1).max(100) }), req);
  res.status(201).json(await kiosk.createPairingCode(getPool(), req.ctx!, body));
});

kioskRouter.get('/devices', authenticate, requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ hotelId: zOptId }), req);
  res.json(await kiosk.listDevices(getPool(), req.ctx!, q.hotelId));
});

kioskRouter.delete('/devices/:id', authenticate, requireRole('manager'), async (req, res) => {
  await kiosk.revokeDevice(getPool(), req.ctx!, idParam(req));
  res.status(204).end();
});
