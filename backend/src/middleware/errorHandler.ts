import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/AppError';
import { ERROR_CATALOG } from '../errors/catalog';
import { mapDbError } from '../db/errorMap';
import { logger } from '../logger';

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError('VALIDATION_ERROR', {
      details: err.issues.map((i) => ({ field: i.path.join('.') || undefined, issue: i.message })),
    });
  }
  const anyErr = err as any;
  if (anyErr?.type === 'entity.parse.failed') return new AppError('VALIDATION_ERROR', { details: [{ issue: 'malformed JSON' }] });
  if (anyErr?.type === 'entity.too.large') return new AppError('VALIDATION_ERROR', { details: [{ issue: 'body too large' }] });
  const mapped = mapDbError(err);
  if (mapped) return mapped;
  return new AppError('INTERNAL_ERROR');
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appErr = toAppError(err);
  if (appErr.code === 'INTERNAL_ERROR') {
    logger.error({ err, requestId: req.requestId }, 'unhandled error');
  }
  const lang = req.ctx?.lang ?? req.lang ?? 'de';
  const message = appErr.customMessage && appErr.customMessage !== appErr.code ? appErr.customMessage : ERROR_CATALOG[appErr.code][lang];
  res.status(appErr.status).json({
    ...(appErr.body ?? {}),
    error: {
      code: appErr.code,
      message,
      ...(appErr.details ? { details: appErr.details } : {}),
      ...(appErr.extra ?? {}),
      requestId: req.requestId,
    },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  const lang = req.lang ?? 'de';
  res.status(404).json({ error: { code: 'RESOURCE_NOT_FOUND', message: ERROR_CATALOG.RESOURCE_NOT_FOUND[lang], requestId: req.requestId } });
}
