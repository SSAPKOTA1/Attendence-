import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireRole } from '../middleware/auth';
import { setEtag } from '../middleware/etag';
import * as to from '../services/timeOffs';
import * as allowance from '../services/allowance';
import { assertRange, idParam, parseBody, parseQuery, zDate, zOptId } from '../validators/common';

export const timeOffsRouter = Router();

const typeEnum = z.enum(['annual_leave', 'sick_leave', 'unpaid_leave', 'school', 'other']);
const baseBody = z.object({
  type: typeEnum,
  startDate: zDate,
  endDate: zDate,
  startHalfDay: z.boolean().optional(),
  endHalfDay: z.boolean().optional(),
});

timeOffsRouter.post('/time-offs/preview', async (req, res) => {
  const body = parseBody(baseBody.extend({ employeeId: z.union([z.number().int().positive(), z.literal('me')]), reason: z.string().max(500).nullable().optional() }), req);
  res.json(await to.preview(getPool(), req.ctx!, body));
});

timeOffsRouter.get('/time-offs', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ hotelId: zOptId, from: zDate.optional(), to: zDate.optional(), type: typeEnum.optional(), status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }), req);
  if (q.from && q.to) assertRange(q.from, q.to);
  res.json(await to.listForHotel(getPool(), req.ctx!, q));
});

timeOffsRouter.get('/time-offs/:id', async (req, res) => {
  const dto = await to.getTimeOff(getPool(), req.ctx!, idParam(req));
  setEtag(res, dto.updatedAt);
  res.json(dto);
});

timeOffsRouter.get('/employees/:id/time-offs', async (req, res) => {
  const q = parseQuery(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), from: zDate.optional(), to: zDate.optional(), status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }), req);
  res.json(await to.listForEmployee(getPool(), req.ctx!, req.params.id as string, q));
});

timeOffsRouter.post('/employees/:id/time-offs', async (req, res) => {
  const body = parseBody(
    baseBody.extend({
      reason: z.string().max(500).nullable().optional(),
      status: z.enum(['pending', 'approved']).optional(),
      unassignConflicts: z.boolean().optional(),
      leaveWishId: z.number().int().positive().optional(),
      overrideReason: z.string().trim().min(1).max(500).optional(),
    }),
    req,
  );
  const dto = await to.createTimeOff(req.ctx!, req.params.id as string, body);
  res.status(201).location(`/api/v1/time-offs/${dto.id}`).json(dto);
});

timeOffsRouter.patch('/time-offs/:id', async (req, res) => {
  const body = parseBody(
    z.object({
      status: z.enum(['approved', 'rejected', 'cancelled']).optional(),
      unassignConflicts: z.boolean().optional(),
      medicalCertificateReceived: z.boolean().optional(),
      startDate: zDate.optional(),
      endDate: zDate.optional(),
      startHalfDay: z.boolean().optional(),
      endHalfDay: z.boolean().optional(),
      reason: z.string().max(500).nullable().optional(),
    }),
    req,
  );
  res.json(await to.updateTimeOff(req.ctx!, idParam(req), body, req));
});

timeOffsRouter.delete('/time-offs/:id', async (req, res) => {
  await to.cancelTimeOff(req.ctx!, idParam(req));
  res.status(204).end();
});

timeOffsRouter.get('/leave-blackouts', async (req, res) => {
  const q = parseQuery(z.object({ hotelId: zOptId, year: z.coerce.number().int().min(2000).max(2100).optional() }), req);
  res.json(await to.listBlackouts(getPool(), req.ctx!, q));
});

timeOffsRouter.post('/leave-blackouts', requireRole('manager'), async (req, res) => {
  const body = parseBody(
    z.object({ hotelId: z.number().int().positive().optional(), startDate: zDate, endDate: zDate, reason: z.string().trim().min(1).max(200), mode: z.enum(['warn', 'block']).default('warn') }),
    req,
  );
  const dto = await to.createBlackout(getPool(), req.ctx!, body);
  res.status(201).location(`/api/v1/leave-blackouts/${dto.id}`).json(dto);
});

timeOffsRouter.delete('/leave-blackouts/:id', requireRole('manager'), async (req, res) => {
  await to.deleteBlackout(getPool(), req.ctx!, idParam(req));
  res.status(204).end();
});

timeOffsRouter.get('/employees/:id/vacation-allowance', async (req, res) => {
  const q = parseQuery(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }), req);
  const dto = await allowance.getAllowance(getPool(), req.ctx!, req.params.id as string, q.year);
  setEtag(res, dto.updatedAt);
  res.json(dto);
});

timeOffsRouter.put('/employees/:id/vacation-allowance', requireRole('manager'), async (req, res) => {
  const body = parseBody(
    z.object({
      year: z.number().int().min(2000).max(2100),
      vacationDaysPerYear: z.number().min(0).max(366),
      carriedOverDays: z.number().min(0).max(366).nullable().optional(),
      alreadyTakenDays: z.number().min(0).max(366).optional(),
      carryOverExpiresOn: zDate.nullable().optional(),
    }),
    req,
  );
  res.json(await withTransaction((db) => allowance.putAllowance(db, req.ctx!, req.params.id as string, body)));
});
