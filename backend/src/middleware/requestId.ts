import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logger';

export function langFromHeader(header: string | undefined): 'de' | 'en' {
  if (!header) return 'de';
  return header.trim().toLowerCase().startsWith('en') ? 'en' : 'de';
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  req.lang = langFromHeader(req.header('accept-language'));
  res.setHeader('X-Request-Id', req.requestId);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    logger.info({
      requestId: req.requestId,
      method: req.method,
      route: req.originalUrl.split('?')[0],
      status: res.statusCode,
      userId: req.ctx?.userId,
      deviceId: req.device?.deviceId,
      durationMs: Number(process.hrtime.bigint() - started) / 1e6,
    }, 'request');
  });
  next();
}
