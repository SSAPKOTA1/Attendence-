import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireRole } from '../middleware/auth';
import { setEtag } from '../middleware/etag';
import * as emp from '../services/employees';
import { listHolidays } from '../services/holidays';
import { loadHotel, resolveHotelId } from '../services/access';
import { paged, parseBody, parseQuery, zDate, zOptId, zPaging } from '../validators/common';

export const employeesRouter = Router();

const weekdays = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .refine((a) => new Set(a).size === a.length, 'duplicate weekday');

const employmentType = z.enum(['full_time', 'part_time', 'mini_job', 'working_student', 'apprentice', 'intern', 'other']);

const employeeBody = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().email().max(254).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  hourlyRate: z.number().min(0).max(999999).nullable().optional(),
  status: z.enum(['active', 'on_leave', 'terminated']).optional(),
  workWeekdays: weekdays.optional(),
  employeeNumber: z.string().trim().min(1).max(30).nullable().optional(),
  birthDate: zDate.nullable().optional(),
  hiredOn: zDate.nullable().optional(),
  terminatedOn: zDate.nullable().optional(),
  employmentType: employmentType.optional(),
  attendanceRequired: z.boolean().optional(),
  // owner decision: chosen when the employee is created (salaried → time account, hourly → paid per hour)
  payType: z.enum(['salary', 'hourly']),
  publicHolidaysOff: z.boolean().default(true),
  homeHotelId: z.number().int().positive(),
  hotelIds: z.array(z.number().int().positive()).optional(),
  departmentIds: z.array(z.number().int().positive()).optional(),
});

employeesRouter.get('/employees', requireRole('manager'), async (req, res) => {
  const q = parseQuery(
    zPaging.extend({ hotelId: zOptId, departmentId: zOptId, status: z.enum(['active', 'on_leave', 'terminated']).optional(), search: z.string().max(100).optional() }),
    req,
  );
  const { data, total } = await emp.listEmployees(getPool(), req.ctx!, q);
  res.json(paged(data, total, q.page, q.limit));
});

employeesRouter.get('/employees/:id', requireRole('manager'), async (req, res) => {
  const dto = await emp.getEmployee(getPool(), req.ctx!, req.params.id as string);
  setEtag(res, dto.updatedAt);
  res.json(dto);
});

employeesRouter.post('/employees', requireRole('manager'), async (req, res) => {
  const body = parseBody(employeeBody, req);
  const dto = await withTransaction((db) => emp.createEmployee(db, req.ctx!, body));
  res.status(201).location(`/api/v1/employees/${dto.id}`).json(dto);
});

employeesRouter.patch('/employees/:id', requireRole('manager'), async (req, res) => {
  const body = parseBody(employeeBody.omit({ homeHotelId: true, hotelIds: true }).extend({ publicHolidaysOff: z.boolean().optional() }).partial(), req);
  res.json(await withTransaction((db) => emp.updateEmployee(db, req.ctx!, req.params.id as string, body)));
});

employeesRouter.delete('/employees/:id', requireRole('manager'), async (req, res) => {
  await withTransaction((db) => emp.deleteEmployee(db, req.ctx!, req.params.id as string));
  res.status(204).end();
});

employeesRouter.get('/employees/:id/work-targets', requireRole('manager'), async (req, res) => {
  res.json(await emp.getTargets(getPool(), req.ctx!, req.params.id as string));
});

const hours = z.number().min(0).max(744);
employeesRouter.put('/employees/:id/work-targets', requireRole('manager'), async (req, res) => {
  const body = parseBody(
    z.object({
      targetHoursPerWeek: hours.optional(),
      minHoursPerWeek: hours.optional(),
      maxHoursPerWeek: hours.optional(),
      targetHoursPerMonth: hours.optional(),
      minHoursPerMonth: hours.optional(),
      maxHoursPerMonth: hours.optional(),
      openingBalanceHours: z.number().min(-9999).max(9999).optional(),
      balanceStartDate: zDate.nullable().optional(),
    }),
    req,
  );
  res.json(await withTransaction((db) => emp.putTargets(db, req.ctx!, req.params.id as string, body)));
});

employeesRouter.put('/employees/:id/hotels', requireRole('manager'), async (req, res) => {
  const body = parseBody(
    z.object({
      hotelIds: z.array(z.number().int().positive()).min(1),
      homeHotelId: z.number().int().positive(),
      departmentIds: z.array(z.number().int().positive()).optional(),
    }),
    req,
  );
  res.json(await withTransaction((db) => emp.putHotels(db, req.ctx!, req.params.id as string, body)));
});

employeesRouter.get('/public-holidays', async (req, res) => {
  const q = parseQuery(z.object({ hotelId: zOptId, year: z.coerce.number().int().min(2000).max(2100).optional() }), req);
  const hotelId = resolveHotelId(req.ctx!, q.hotelId);
  const hotel = await loadHotel(getPool(), hotelId);
  const year = q.year ?? new Date().getUTCFullYear();
  res.json({ data: listHolidays(hotel.holidayRegion, year, req.ctx!.lang) });
});
