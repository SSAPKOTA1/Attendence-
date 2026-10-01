import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireRole } from '../middleware/auth';
import * as users from '../services/users';
import { idParam, paged, parseBody, parseQuery, zPaging } from '../validators/common';

export const usersRouter = Router();
usersRouter.use(requireRole('manager'));

usersRouter.get('/', async (req, res) => {
  const q = parseQuery(zPaging.extend({ role: z.enum(['staff', 'manager', 'admin']).optional(), status: z.enum(['invited', 'active', 'disabled']).optional() }), req);
  const { data, total } = await users.listUsers(getPool(), req.ctx!, q);
  res.json(paged(data, total, q.page, q.limit));
});

usersRouter.post('/', async (req, res) => {
  const body = parseBody(
    z.object({
      email: z.string().email().max(254).nullable().optional(),
      username: z.string().max(40).nullable().optional(),
      role: z.enum(['staff', 'manager', 'admin']).default('staff'),
      employeeId: z.number().int().positive().nullable().optional(),
      hotelIds: z.array(z.number().int().positive()).optional(),
      firstName: z.string().max(100).nullable().optional(),
      lastName: z.string().max(100).nullable().optional(),
      preferredLanguage: z.enum(['de', 'en']).optional(),
      deliver: z.enum(['email', 'link']).optional(),
    }),
    req,
  );
  const u = await withTransaction((db) => users.createUser(db, req.ctx!, body));
  res.status(201).location(`/api/v1/users/${u.id}`).json(u);
});

usersRouter.patch('/:id', async (req, res) => {
  const body = parseBody(
    z.object({
      email: z.string().email().max(254).nullable().optional(),
      username: z.string().regex(/^[A-Za-z0-9._]{3,40}$/).nullable().optional(),
      firstName: z.string().max(100).nullable().optional(),
      lastName: z.string().max(100).nullable().optional(),
      role: z.enum(['staff', 'manager', 'admin']).optional(),
      status: z.enum(['active', 'disabled']).optional(),
      preferredLanguage: z.enum(['de', 'en']).optional(),
    }),
    req,
  );
  res.json(await withTransaction((db) => users.updateUser(db, req.ctx!, idParam(req), body)));
});

usersRouter.delete('/:id', async (req, res) => {
  await withTransaction((db) => users.deleteUser(db, req.ctx!, idParam(req)));
  res.status(204).end();
});

usersRouter.post('/:id/invite', async (req, res) => {
  const body = parseBody(z.object({ deliver: z.enum(['email', 'link']).optional() }), req);
  res.json(await withTransaction((db) => users.inviteUser(db, req.ctx!, idParam(req), body.deliver)));
});

usersRouter.put('/:id/hotel-access', requireRole('admin'), async (req, res) => {
  const body = parseBody(z.object({ hotelIds: z.array(z.number().int().positive()) }), req);
  res.json(await withTransaction((db) => users.setHotelAccess(db, req.ctx!, idParam(req), body.hotelIds)));
});

usersRouter.post('/:id/password-reset-link', async (req, res) => {
  res.json(await withTransaction((db) => users.passwordResetLink(db, req.ctx!, idParam(req))));
});
