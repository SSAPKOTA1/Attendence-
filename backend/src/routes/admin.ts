import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/auth';
import * as org from '../services/org';
import { idParam, parseBody } from '../validators/common';

export const adminRouter = Router();

adminRouter.get('/companies', requireRole('admin'), async (req, res) => {
  res.json({ data: await org.listCompanies(getPool(), req.ctx!) });
});

adminRouter.post('/companies', requireRole('admin'), async (req, res) => {
  const body = parseBody(z.object({ name: z.string().trim().min(1).max(200) }), req);
  const c = await org.createCompany(getPool(), req.ctx!, body.name);
  res.status(201).location(`/api/v1/companies/${c.id}`).json(c);
});

adminRouter.patch('/companies/:id', requireRole('admin'), async (req, res) => {
  const body = parseBody(z.object({ name: z.string().trim().min(1).max(200) }), req);
  res.json(await org.updateCompany(getPool(), req.ctx!, idParam(req), body.name));
});

adminRouter.get('/hotels', requireRole('manager'), async (req, res) => {
  res.json({ data: await org.listHotels(getPool(), req.ctx!) });
});

const hotelBody = z.object({
  name: z.string().trim().min(1).max(200),
  city: z.string().max(200).nullable().optional(),
  timezone: z.string().max(64).optional(),
  holidayRegion: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/).optional(),
  settings: z.unknown().optional(),
});

adminRouter.post('/hotels', requireRole('admin'), async (req, res) => {
  const body = parseBody(hotelBody, req);
  const h = await org.createHotel(getPool(), req.ctx!, body);
  res.status(201).location(`/api/v1/hotels/${h.id}`).json(h);
});

adminRouter.patch('/hotels/:id', requireRole('admin'), async (req, res) => {
  const body = parseBody(hotelBody.partial().omit({ settings: true }), req);
  res.json(await org.updateHotel(getPool(), req.ctx!, idParam(req), body));
});

adminRouter.delete('/hotels/:id', requireRole('admin'), async (req, res) => {
  await org.deleteHotel(getPool(), req.ctx!, idParam(req));
  res.status(204).end();
});

adminRouter.get('/hotels/:id/settings', requireRole('manager'), async (req, res) => {
  res.json(await org.getSettings(getPool(), req.ctx!, idParam(req)));
});

adminRouter.put('/hotels/:id/settings', requireRole('admin'), async (req, res) => {
  res.json(await org.putSettings(getPool(), req.ctx!, idParam(req), req.body));
});
