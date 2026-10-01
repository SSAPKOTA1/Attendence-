import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/auth';
import * as wishes from '../services/wishes';
import { idParam, parseBody, parseQuery, zDate, zOptId } from '../validators/common';

export const wishesRouter = Router();

const status = z.enum(['pending', 'approved', 'rejected', 'cancelled']);
const listQuery = z.object({ hotelId: zOptId, from: zDate.optional(), to: zDate.optional(), status: status.optional(), employeeId: z.union([z.literal('me'), z.string().regex(/^\d+$/)]).optional() });
const decision = z.object({ status: z.enum(['approved', 'rejected', 'cancelled']), decisionNote: z.string().max(1000).nullable().optional() });

wishesRouter.get('/shift-wishes', async (req, res) => {
  res.json(await wishes.listShiftWishes(getPool(), req.ctx!, parseQuery(listQuery, req)));
});

wishesRouter.post('/employees/:id/shift-wishes', async (req, res) => {
  const body = parseBody(
    z.object({
      hotelId: z.number().int().positive().optional(),
      date: zDate,
      shiftId: z.number().int().positive().nullable().optional(),
      kind: z.enum(['prefer', 'avoid']),
      priority: z.number().int().min(1).max(3).optional(),
      reason: z.string().max(500).nullable().optional(),
    }),
    req,
  );
  const dto = await wishes.createShiftWish(getPool(), req.ctx!, req.params.id as string, body);
  res.status(201).location(`/api/v1/shift-wishes/${dto.id}`).json(dto);
});

wishesRouter.patch('/shift-wishes/:id', async (req, res) => {
  res.json(await wishes.decideShiftWish(getPool(), req.ctx!, idParam(req), parseBody(decision, req)));
});

wishesRouter.get('/leave-wishes', async (req, res) => {
  res.json(await wishes.listLeaveWishes(getPool(), req.ctx!, parseQuery(listQuery, req)));
});

wishesRouter.post('/employees/:id/leave-wishes', async (req, res) => {
  const body = parseBody(
    z.object({
      startDate: zDate,
      endDate: zDate,
      leaveDays: z.number().positive().max(366).optional(),
      priority: z.number().int().min(1).max(3).optional(),
      reason: z.string().max(500).nullable().optional(),
    }),
    req,
  );
  const dto = await wishes.createLeaveWish(getPool(), req.ctx!, req.params.id as string, body);
  res.status(201).location(`/api/v1/leave-wishes/${dto.id}`).json(dto);
});

wishesRouter.patch('/leave-wishes/:id', async (req, res) => {
  res.json(await wishes.decideLeaveWish(getPool(), req.ctx!, idParam(req), parseBody(decision, req)));
});

wishesRouter.get('/hotels/:id/planning-dashboard', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ from: zDate.optional(), to: zDate.optional() }), req);
  res.json(await wishes.planningDashboard(getPool(), req.ctx!, idParam(req), q));
});
