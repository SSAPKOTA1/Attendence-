import { AppError } from '../errors/AppError';

export interface DbErrorContext {
  /** time entries: kiosk punches map overlap to INVALID_PUNCH_STATE, manual entries to TIME_ENTRY_OVERLAP */
  timeEntrySource?: 'kiosk' | 'manual';
}

/** Maps PostgreSQL errors to API errors (Appendix B). Returns null for non-DB errors. */
export function mapDbError(err: any, ctx: DbErrorContext = {}): AppError | null {
  if (!err || typeof err.code !== 'string' || !/^[0-9A-Z]{5}$/.test(err.code)) return null;
  const constraint: string = err.constraint ?? '';
  const message: string = err.message ?? '';
  switch (err.code) {
    case '23505':
      if (constraint === 'uq_schedule_same_shift' || constraint === 'uq_schedule_one_off') {
        return new AppError('EMPLOYEE_ALREADY_SCHEDULED');
      }
      return new AppError('DUPLICATE_RESOURCE', { details: [{ issue: 'already exists' }] });
    case '23P01':
      if (['no_overlapping_time_offs', 'no_overlapping_sick_leave', 'no_overlapping_leave_wishes'].includes(constraint)) {
        return new AppError('TIME_OFF_OVERLAP');
      }
      if (constraint === 'no_overlapping_time_entries') {
        return new AppError(ctx.timeEntrySource === 'kiosk' ? 'INVALID_PUNCH_STATE' : 'TIME_ENTRY_OVERLAP');
      }
      return new AppError('VALIDATION_ERROR', { details: [{ issue: 'conflicting value' }] });
    case '23514':
      if (message.includes("does not work in this shift's department")) return new AppError('EMPLOYEE_NOT_IN_DEPARTMENT');
      if (message.includes('not assigned to this hotel')) return new AppError('EMPLOYEE_NOT_ASSIGNED_TO_HOTEL');
      if (message.includes('Shift overlaps another shift')) return new AppError('SHIFT_OVERLAPS_EXISTING');
      if (message.includes('Day off cannot coexist')) return new AppError('EMPLOYEE_ALREADY_SCHEDULED');
      return new AppError('VALIDATION_ERROR', { details: [{ issue: 'value not allowed' }] });
    case '23503':
      return new AppError('RESOURCE_NOT_FOUND', { details: [{ issue: 'reference not found' }] });
    case '23502':
      return new AppError('VALIDATION_ERROR', { details: [{ field: err.column ?? 'field', issue: 'required' }] });
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return new AppError('VALIDATION_ERROR', { details: [{ issue: 'invalid value' }] });
    default:
      return null;
  }
}
