import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/auth';
import { setEtag } from '../middleware/etag';
import * as sched from '../services/roster/schedules';
import { bulkCreate, copyWeek } from '../services/roster/bulk';
import { publish, unpublish } from '../services/roster/publish';
import { workSummary } from '../services/workSummary';
import { assertRange, idParam, parseBody, parseQuery, zBoolish, zDate, zOptId } from '../validators/common';

export const schedulesRouter = Router();

const entryBody = z
  .object({
    hotelId: z.number().int().positive().optional(),
    entryType: z.enum(['shift', 'off']).default('shift'),
    employeeId: z.number().int().positive(),
    shiftId: z.number().int().positive().nullable().optional(),
    date: zDate,
    offLabel: z.string().trim().max(50).nullable().optional(),
    overrideReason: z.string().trim().min(1).max(1000).nullable().optional(),
    allowPast: z.boolean().optional(),
    wishId: z.number().int().positive().optional(),
  })
  .superRefine((v, c) => {
    if (v.entryType === 'shift' && !v.shiftId) c.addIssue({ code: 'custom', path: ['shiftId'], message: 'required for shift entries' });
    if (v.entryType === 'off' && v.shiftId) c.addIssue({ code: 'custom', path: ['shiftId'], message: 'must be empty for off entries' });
    if (v.entryType === 'shift' && v.offLabel) c.addIssue({ code: 'custom', path: ['offLabel'], message: 'only for off entries' });
  });

schedulesRouter.get('/schedules', async (req, res) => {
  const q = parseQuery(
    z.object({
      hotelId: zOptId,
      from: zDate,
      to: zDate,
      departmentId: zOptId,
      employeeId: z.union([z.literal('me'), z.string().regex(/^\d+$/)]).optional(),
      status: z.enum(['draft', 'published']).optional(),
    }),
    req,
  );
  assertRange(q.from, q.to);
  res.json(await sched.listSchedules(getPool(), req.ctx!, q));
});

schedulesRouter.get('/schedules/coverage', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ hotelId: zOptId, from: zDate, to: zDate, departmentId: zOptId }), req);
  assertRange(q.from, q.to);
  res.json(await sched.coverage(getPool(), req.ctx!, q));
});

schedulesRouter.get('/schedules/candidates', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ hotelId: zOptId, date: zDate, shiftId: z.coerce.number().int().positive() }), req);
  res.json(await sched.candidates(getPool(), req.ctx!, q));
});

schedulesRouter.get('/schedules/:id', async (req, res) => {
  const dto = await sched.getSchedule(getPool(), req.ctx!, idParam(req));
  setEtag(res, dto.updatedAt);
  res.json(dto);
});

schedulesRouter.post('/schedules/validate', requireRole('manager'), async (req, res) => {
  const body = parseBody(entryBody, req);
  res.json(await sched.validateSchedule(req.ctx!, body));
});

schedulesRouter.post('/schedules/bulk', requireRole('manager'), async (req, res) => {
  const item = z.object({
    entryType: z.enum(['shift', 'off']).default('shift'),
    employeeId: z.number().int().positive(),
    shiftId: z.number().int().positive().nullable().optional(),
    date: zDate,
    offLabel: z.string().trim().max(50).nullable().optional(),
    overrideReason: z.string().trim().min(1).max(1000).nullable().optional(),
  });
  const body = parseBody(
    z.object({ hotelId: z.number().int().positive().optional(), mode: z.enum(['partial', 'atomic']).default('partial'), items: z.array(item).min(1).max(500) }),
    req,
  );
  res.json(await bulkCreate(req.ctx!, body));
});

schedulesRouter.post('/schedules/copy', requireRole('manager'), async (req, res) => {
  const body = parseBody(
    z.object({
      hotelId: z.number().int().positive().optional(),
      sourceFrom: zDate,
      sourceTo: zDate,
      targetFrom: zDate,
      departmentId: z.number().int().positive().optional(),
      employeeIds: z.array(z.number().int().positive()).optional(),
      overwrite: z.boolean().default(false),
    }),
    req,
  );
  res.json(await copyWeek(req.ctx!, body));
});

const rangeBody = z.object({ hotelId: z.number().int().positive().optional(), from: zDate, to: zDate, departmentId: z.number().int().positive().optional() });

schedulesRouter.post('/schedules/publish', requireRole('manager'), async (req, res) => {
  const body = parseBody(rangeBody, req);
  assertRange(body.from, body.to);
  res.json(await publish(req.ctx!, body));
});

schedulesRouter.post('/schedules/unpublish', requireRole('manager'), async (req, res) => {
  const body = parseBody(rangeBody, req);
  assertRange(body.from, body.to);
  res.json(await unpublish(req.ctx!, body));
});

schedulesRouter.post('/schedules', requireRole('manager'), async (req, res) => {
  const body = parseBody(entryBody, req);
  const dto = await sched.createSchedule(req.ctx!, body);
  res.status(201).location(`/api/v1/schedules/${dto.id}`).json(dto);
});

schedulesRouter.patch('/schedules/:id', requireRole('manager'), async (req, res) => {
  const body = parseBody(
    z.object({
      shiftId: z.number().int().positive().nullable().optional(),
      employeeId: z.number().int().positive().optional(),
      entryType: z.enum(['shift', 'off']).optional(),
      offLabel: z.string().trim().max(50).nullable().optional(),
      date: zDate.optional(),
      overrideReason: z.string().trim().min(1).max(1000).nullable().optional(),
      allowPast: z.boolean().optional(),
    }),
    req,
  );
  res.json(await sched.updateSchedule(req.ctx!, idParam(req), body, req));
});

schedulesRouter.delete('/schedules/:id', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ allowPast: zBoolish.optional() }), req);
  res.json(await sched.deleteSchedule(req.ctx!, idParam(req), !!q.allowPast));
});

schedulesRouter.get('/employees/:id/work-summary', async (req, res) => {
  const q = parseQuery(z.object({ from: zDate.optional(), to: zDate.optional() }), req);
  if (q.from && q.to) assertRange(q.from, q.to, 370);
  res.json(await workSummary(getPool(), req.ctx!, req.params.id as string, q));
});
