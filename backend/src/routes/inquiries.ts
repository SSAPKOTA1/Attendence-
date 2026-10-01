import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool';
import * as inq from '../services/inquiries';
import { idParam, paged, parseBody, parseQuery, zOptId, zPaging } from '../validators/common';

export const inquiriesRouter = Router();

const body = z.string().refine((s) => s.trim().length >= 1, 'must not be empty').refine((s) => s.length <= 4000, 'max 4000 characters');

inquiriesRouter.post('/inquiries', async (req, res) => {
  const input = parseBody(
    z.object({
      subject: z.string().trim().min(1).max(120),
      category: z.enum(['roster', 'hours', 'vacation', 'attendance', 'other']).default('other'),
      body,
      related: z
        .object({ type: z.enum(['schedule', 'time_entry', 'time_off', 'shift_wish', 'leave_wish', 'correction']), id: z.number().int().positive() })
        .nullable()
        .optional(),
    }),
    req,
  );
  const dto = await inq.createInquiry(req.ctx!, input);
  res.status(201).location(`/api/v1/inquiries/${dto.id}`).json(dto);
});

inquiriesRouter.get('/inquiries', async (req, res) => {
  const q = parseQuery(zPaging.extend({ status: z.enum(['open', 'answered', 'closed']).optional(), hotelId: zOptId }), req);
  const { data, total } = await inq.listInquiries(getPool(), req.ctx!, q);
  res.json(paged(data, total, q.page, q.limit));
});

inquiriesRouter.get('/inquiries/:id', async (req, res) => {
  res.json(await inq.getInquiry(getPool(), req.ctx!, idParam(req)));
});

inquiriesRouter.post('/inquiries/:id/messages', async (req, res) => {
  const input = parseBody(z.object({ body }), req);
  res.status(201).json(await inq.addMessage(req.ctx!, idParam(req), input.body));
});

inquiriesRouter.patch('/inquiries/:id', async (req, res) => {
  const input = parseBody(z.object({ status: z.enum(['open', 'closed']).optional(), assignedToId: z.number().int().positive().nullable().optional() }), req);
  res.json(await inq.updateInquiry(getPool(), req.ctx!, idParam(req), input));
});
