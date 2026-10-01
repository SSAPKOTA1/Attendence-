import { ERROR_CATALOG, ErrorCode } from './catalog';

export interface ErrorDetail {
  field?: string;
  issue?: string;
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[] | unknown[];
  /** Extra top-level fields in the error object (e.g. attemptsLeft, lockedUntil). */
  readonly extra?: Record<string, unknown>;
  /** Extra top-level response fields next to `error` (e.g. bulk results). */
  readonly body?: Record<string, unknown>;
  readonly customMessage?: string;

  constructor(
    code: ErrorCode,
    opts: { message?: string; details?: ErrorDetail[] | unknown[]; extra?: Record<string, unknown>; body?: Record<string, unknown>; status?: number } = {},
  ) {
    super(opts.message ?? code);
    this.code = code;
    this.status = opts.status ?? ERROR_CATALOG[code].status;
    this.details = opts.details;
    this.extra = opts.extra;
    this.body = opts.body;
    this.customMessage = opts.message;
  }
}

export const notFound = (what = 'resource') => new AppError('RESOURCE_NOT_FOUND', { details: [{ field: what, issue: 'not found' }] });
export const forbidden = (issue = 'not allowed') => new AppError('FORBIDDEN', { details: [{ issue }] });
export const validation = (field: string, issue: string) => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
