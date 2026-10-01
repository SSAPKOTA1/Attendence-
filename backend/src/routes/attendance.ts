import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireRole } from '../middleware/auth';
import { setEtag } from '../middleware/etag';
import { AppError } from '../errors/AppError';
import * as att from '../services/attendance';
import * as pins from '../services/pins';
import { getTimeAccount } from '../services/timeAccount';
import { attendanceExport, payrollExport } from '../services/payroll';
import { resolveHotelId } from '../services/access';
import { assertRange, idParam, parseBody, parseQuery, zDate, zInstant, zMonth, zOptId } from '../validators/common';

export const attendanceRouter = Router();

// ---- PINs ----
attendanceRouter.put('/employees/me/pin', async (req, res) => {
  const body = parseBody(z.object({ currentPassword: z.string().min(1), newPin: z.string().regex(/^\d{6}$/, '6 digits') }), req);
  await pins.setOwnPin(getPool(), req.ctx!, body.currentPassword, body.newPin);
  res.status(204).end();
});

attendanceRouter.post('/employees/:id/pin/reset', requireRole('manager'), async (req, res) => {
  res.json(await withTransaction((db) => pins.resetPin(db, req.ctx!, req.params.id as string)));
});

attendanceRouter.post('/employees/:id/pin/unlock', requireRole('manager'), async (req, res) => {
  await pins.unlockPin(getPool(), req.ctx!, req.params.id as string);
  res.status(204).end();
});

attendanceRouter.get('/employees/:id/time-account', async (req, res) => {
  const q = parseQuery(z.object({ from: zMonth.optional(), to: zMonth.optional() }), req);
  res.json(await getTimeAccount(getPool(), req.ctx!, req.params.id as string, q));
});

// ---- attendance ----
attendanceRouter.get('/attendance', async (req, res) => {
  const q = parseQuery(
    z.object({
      hotelId: zOptId,
      from: zDate,
      to: zDate,
      employeeId: z.union([z.literal('me'), z.string().regex(/^\d+$/)]).optional(),
      status: z.enum(['open', 'closed', 'needs_review']).optional(),
      anomaly: z.string().max(40).optional(),
    }),
    req,
  );
  assertRange(q.from, q.to);
  res.json(await att.listEntries(getPool(), req.ctx!, q));
});

attendanceRouter.get('/attendance/live', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ hotelId: zOptId, departmentId: zOptId }), req);
  res.json(await att.liveBoard(getPool(), req.ctx!, q));
});

attendanceRouter.get('/attendance/export', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ hotelId: zOptId, from: zDate, to: zDate, format: z.literal('csv').default('csv') }), req);
  assertRange(q.from, q.to, 370);
  const hotelId = resolveHotelId(req.ctx!, q.hotelId);
  const csv = await attendanceExport(getPool(), req.ctx!, hotelId, q.from, q.to);
  res.type('text/csv; charset=utf-8').setHeader('Content-Disposition', `attachment; filename="attendance-${hotelId}-${q.from}-${q.to}.csv"`);
  res.send(csv);
});

attendanceRouter.get('/attendance/corrections', async (req, res) => {
  const q = parseQuery(z.object({ hotelId: zOptId, status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), employeeId: z.literal('me').optional() }), req);
  res.json(await att.listCorrections(getPool(), req.ctx!, q));
});

attendanceRouter.patch('/attendance/corrections/:id', async (req, res) => {
  const body = parseBody(
    z.object({ status: z.enum(['approved', 'rejected', 'cancelled']), decisionNote: z.string().max(1000).nullable().optional(), reason: z.string().max(1000).nullable().optional() }),
    req,
  );
  res.json(await att.decideCorrection(req.ctx!, idParam(req), body, req));
});

attendanceRouter.get('/attendance/:id', async (req, res) => {
  const dto = await att.getEntry(getPool(), req.ctx!, idParam(req));
  setEtag(res, dto.updatedAt);
  res.json(dto);
});

attendanceRouter.post('/attendance', requireRole('manager'), async (req, res) => {
  const body = parseBody(
    z.object({
      hotelId: z.number().int().positive().optional(),
      employeeId: z.number().int().positive(),
      clockInAt: zInstant,
      clockOutAt: zInstant.nullable().optional(),
      breakMinutes: z.number().int().min(0).max(1440).optional(),
      reason: z.string().trim().min(1).max(1000),
    }),
    req,
  );
  const dto = await att.createManualEntry(req.ctx!, body);
  res.status(201).location(`/api/v1/attendance/${dto.id}`).json(dto);
});

attendanceRouter.patch('/attendance/:id', requireRole('manager'), async (req, res) => {
  const body = parseBody(
    z.object({
      clockInAt: zInstant.optional(),
      clockOutAt: zInstant.nullable().optional(),
      breakMinutes: z.number().int().min(0).max(1440).optional(),
      reason: z.string().trim().min(1).max(1000),
    }),
    req,
  );
  res.json(await att.managerChange(req.ctx!, idParam(req), body, req));
});

attendanceRouter.post('/attendance/:id/corrections', async (req, res) => {
  const body = parseBody(
    z.object({
      proposedClockInAt: zInstant.optional(),
      proposedClockOutAt: zInstant.optional(),
      proposedBreakMinutes: z.number().int().min(0).max(1440).optional(),
      reason: z.string().trim().min(1).max(1000),
    }),
    req,
  );
  const dto = await att.requestCorrection(req.ctx!, idParam(req), body);
  res.status(201).json(dto);
});

attendanceRouter.put('/hotels/:id/attendance-lock', requireRole('manager'), async (req, res) => {
  const body = parseBody(z.object({ lockedUntil: zDate, reason: z.string().max(500).optional() }), req);
  res.json(await att.setLock(getPool(), req.ctx!, idParam(req), body.lockedUntil, body.reason));
});

attendanceRouter.get('/hotels/:id/payroll-export', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ month: zMonth, format: z.enum(['csv', 'json', 'datev']).default('json') }), req);
  const hotelId = idParam(req);
  const out = await payrollExport(getPool(), req.ctx!, hotelId, q.month, q.format);
  if (out.kind === 'json') return res.json(out.body);
  if (out.warnings.length) res.setHeader('X-Warnings', out.warnings.join(','));
  if (out.kind === 'csv') {
    res.type('text/csv; charset=utf-8').setHeader('Content-Disposition', `attachment; filename="payroll-${hotelId}-${q.month}.csv"`);
    return res.send(out.body);
  }
  if (!Buffer.isBuffer(out.body)) throw new AppError('INTERNAL_ERROR');
  res.setHeader('Content-Type', 'text/plain; charset=windows-1252');
  res.setHeader('Content-Disposition', `attachment; filename="datev-${hotelId}-${q.month}.txt"`);
  res.end(out.body);
});
