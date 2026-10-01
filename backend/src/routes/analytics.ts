import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireRole } from '../middleware/auth';
import * as an from '../services/analytics';
import { anonymizeEmployee } from '../services/retention';
import { idParam, paged, parseBody, parseQuery, zDate, zMonth, zOptId, zPaging } from '../validators/common';

export const analyticsRouter = Router();

analyticsRouter.get('/hotels/:id/analytics/absences', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ from: zDate, to: zDate, departmentId: zOptId }), req);
  res.json(await an.absences(getPool(), req.ctx!, idParam(req), q));
});

analyticsRouter.get('/hotels/:id/analytics/absences/trend', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ from: zDate, to: zDate, granularity: z.literal('month').default('month') }), req);
  res.json(await an.absenceTrend(getPool(), req.ctx!, idParam(req), q));
});

analyticsRouter.get('/hotels/:id/analytics/hours', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ month: zMonth }), req);
  res.json(await an.hours(getPool(), req.ctx!, idParam(req), q.month));
});

analyticsRouter.get('/hotels/:id/analytics/attendance', requireRole('manager'), async (req, res) => {
  const q = parseQuery(z.object({ from: zDate, to: zDate }), req);
  res.json(await an.attendanceAnalytics(getPool(), req.ctx!, idParam(req), q));
});

analyticsRouter.get('/analytics/overview', requireRole('manager'), async (req, res) => {
  const q = parseQuery(
    z.object({
      hotelIds: z.string().regex(/^\d+(,\d+)*$/).optional().transform((s) => (s ? s.split(',').map(Number) : undefined)),
      from: zDate,
      to: zDate,
    }),
    req,
  );
  res.json(await an.overview(getPool(), req.ctx!, q));
});

analyticsRouter.get('/audit-logs', requireRole('manager'), async (req, res) => {
  const q = parseQuery(
    zPaging.extend({
      hotelId: zOptId,
      entityType: z.string().max(50).optional(),
      entityId: zOptId,
      userId: zOptId,
      action: z.string().max(80).optional(),
      from: zDate.optional(),
      to: zDate.optional(),
    }),
    req,
  );
  const { data, total } = await an.auditLogs(getPool(), req.ctx!, q);
  res.json(paged(data, total, q.page, q.limit));
});

analyticsRouter.post('/employees/:id/anonymize', requireRole('admin'), async (req, res) => {
  const body = parseBody(z.object({ force: z.boolean().optional(), reason: z.string().trim().min(1).max(1000).optional() }), req);
  res.json(await withTransaction((db) => anonymizeEmployee(db, req.ctx!, req.params.id as string, body)));
});
