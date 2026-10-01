import type { Request, Response } from 'express';
import { AppError } from '../errors/AppError';

export function etagOf(updatedAt: Date | string | null | undefined): string | null {
  if (!updatedAt) return null;
  return `W/"${new Date(updatedAt).getTime()}"`;
}

export function setEtag(res: Response, updatedAt: Date | string | null | undefined): void {
  const tag = etagOf(updatedAt);
  if (tag) res.setHeader('ETag', tag);
}

/** Optimistic concurrency: If-Match must equal the current ETag when sent. */
export function checkIfMatch(req: Request, updatedAt: Date | string | null | undefined): void {
  const header = req.header('if-match');
  if (!header) return;
  const current = etagOf(updatedAt);
  const normalize = (s: string) => s.trim().replace(/^W\//, '');
  if (!current || normalize(header) !== normalize(current)) throw new AppError('PRECONDITION_FAILED');
}
