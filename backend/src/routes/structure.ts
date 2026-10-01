import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireRole } from '../middleware/auth';
import * as st from '../services/structure';
import { idParam, paged, parseBody, parseQuery, zOptId, zPaging, zTime } from '../validators/common';

export const structureRouter = Router();

const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional();

structureRouter.get('/departments', async (req, res) => {
  const q = parseQuery(zPaging.extend({ hotelId: zOptId }), req);
  const { data, total } = await st.listDepartments(getPool(), req.ctx!, q);
  res.json(paged(data, total, q.page, q.limit));
});

structureRouter.get('/departments/:id', async (req, res) => {
  res.json(await st.getDepartment(getPool(), req.ctx!, idParam(req)));
});

structureRouter.post('/departments', requireRole('manager'), async (req, res) => {
  const body = parseBody(z.object({ hotelId: z.number().int().positive().optional(), name: z.string().trim().min(1).max(100), color }), req);
  const d = await st.createDepartment(getPool(), req.ctx!, body);
  res.status(201).location(`/api/v1/departments/${d.id}`).json(d);
});

structureRouter.patch('/departments/:id', requireRole('manager'), async (req, res) => {
  const body = parseBody(z.object({ name: z.string().trim().min(1).max(100).optional(), color }), req);
  res.json(await st.updateDepartment(getPool(), req.ctx!, idParam(req), body));
});

structureRouter.delete('/departments/:id', requireRole('manager'), async (req, res) => {
  await st.deleteDepartment(getPool(), req.ctx!, idParam(req));
  res.status(204).end();
});

structureRouter.get('/shifts', async (req, res) => {
  const q = parseQuery(zPaging.extend({ hotelId: zOptId, departmentId: zOptId }), req);
  const { data, total } = await st.listShifts(getPool(), req.ctx!, q);
  res.json(paged(data, total, q.page, q.limit));
});

const shiftBody = z.object({
  hotelId: z.number().int().positive().optional(),
  departmentId: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  startTime: zTime,
  endTime: zTime,
  breakDurationMinutes: z.number().int().min(0).max(1439).default(0),
});

// owner decision (SPEC 1.9): shift templates are designed by admins; managers assign them in the roster
structureRouter.post('/shifts', requireRole('admin'), async (req, res) => {
  const body = parseBody(shiftBody, req);
  const s = await st.createShift(getPool(), req.ctx!, body);
  res.status(201).location(`/api/v1/shifts/${s.id}`).json(s);
});

structureRouter.get('/shifts/:id', async (req, res) => {
  res.json(st.shiftDto(await st.loadShift(getPool(), req.ctx!, idParam(req))));
});

structureRouter.patch('/shifts/:id', requireRole('admin'), async (req, res) => {
  const body = parseBody(shiftBody.omit({ hotelId: true }).partial(), req);
  res.json(await st.updateShift(getPool(), req.ctx!, idParam(req), body));
});

structureRouter.delete('/shifts/:id', requireRole('admin'), async (req, res) => {
  await st.deleteShift(getPool(), req.ctx!, idParam(req));
  res.status(204).end();
});

structureRouter.get('/shifts/:id/staffing-requirements', requireRole('manager'), async (req, res) => {
  res.json(await st.getStaffing(getPool(), req.ctx!, idParam(req)));
});

structureRouter.put('/shifts/:id/staffing-requirements', requireRole('manager'), async (req, res) => {
  const item = z.object({ weekday: z.number().int().min(1).max(7), minStaff: z.number().int().min(0).max(1000) });
  const raw = Array.isArray(req.body) ? { requirements: req.body } : req.body;
  const body = z.object({ requirements: z.array(item).max(7) }).parse(raw ?? {});
  res.json(await withTransaction((db) => st.putStaffing(db, req.ctx!, idParam(req), body.requirements)));
});
