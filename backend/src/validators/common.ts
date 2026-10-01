import { z } from 'zod';
import type { Request } from 'express';
import { isValidDate, daysBetween } from '../domain/dates';
import { AppError } from '../errors/AppError';

export const zDate = z.string().refine(isValidDate, 'expected YYYY-MM-DD');
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');
export const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');
export const zId = z.coerce.number().int().positive();
export const zOptId = z.coerce.number().int().positive().optional();
export const zIdParam = z.object({ id: zId });
export const zBoolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');
export const zInstant = z.string().datetime({ offset: true }).transform((s) => new Date(s));

export const zPaging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function parseBody<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  return schema.parse(req.body ?? {});
}

export function parseQuery<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  return schema.parse(req.query ?? {});
}

export function parseParams<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  return schema.parse(req.params ?? {});
}

export function idParam(req: Request, name = 'id'): number {
  const v = Number(req.params[name]);
  if (!Number.isInteger(v) || v <= 0) throw new AppError('RESOURCE_NOT_FOUND');
  return v;
}

/** Calendar endpoints are range based: max 62 days (section 4). */
export function assertRange(from: string, to: string, maxDays = 62): void {
  if (to < from) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'to', issue: 'must not be before from' }] });
  if (daysBetween(from, to) + 1 > maxDays) throw new AppError('RANGE_TOO_LARGE');
}

export function paged<T>(data: T[], total: number, page: number, limit: number, extraMeta: Record<string, unknown> = {}) {
  return { data, meta: { page, limit, total, ...extraMeta } };
}

export const zPassword = z.string().min(10, 'at least 10 characters').max(200);
