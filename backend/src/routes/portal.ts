import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool';
import * as portal from '../services/portal';
import { idParam, parseBody, parseQuery, zBoolish, zPaging } from '../validators/common';

export const portalRouter = Router();

portalRouter.get('/me/dashboard', async (req, res) => {
  res.json(await portal.dashboard(getPool(), req.ctx!));
});

portalRouter.get('/me/profile', async (req, res) => {
  res.json(await portal.profile(getPool(), req.ctx!));
});

portalRouter.patch('/me/profile', async (req, res) => {
  // name, e-mail, rate and hours are managed by managers: unknown fields are ignored
  const body = parseBody(z.object({ phone: z.string().max(50).nullable().optional(), preferredLanguage: z.enum(['de', 'en']).optional() }), req);
  res.json(await portal.updateProfile(getPool(), req.ctx!, body));
});

portalRouter.get('/notifications', async (req, res) => {
  const q = parseQuery(zPaging.extend({ unread: zBoolish.optional() }), req);
  res.json(await portal.listNotifications(getPool(), req.ctx!, q));
});

portalRouter.post('/notifications/read-all', async (req, res) => {
  res.json(await portal.readAll(getPool(), req.ctx!));
});

portalRouter.patch('/notifications/:id', async (req, res) => {
  const body = parseBody(z.object({ read: z.boolean() }), req);
  res.json(await portal.markNotification(getPool(), req.ctx!, idParam(req), body.read));
});

portalRouter.get('/me/notification-preferences', async (req, res) => {
  res.json(await portal.getPreferences(getPool(), req.ctx!));
});

portalRouter.put('/me/notification-preferences', async (req, res) => {
  const body = z.record(z.object({ email: z.boolean() })).parse(req.body ?? {});
  res.json(await portal.putPreferences(getPool(), req.ctx!, body));
});
