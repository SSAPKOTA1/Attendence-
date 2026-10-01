/**
 * SPEC 1.12: a time entry counts toward worked hours, payroll and the time account only when it is closed AND not
 * waiting for / refused by a supervisor. Entries of planned shifts are 'not_required'.
 * (SQL equivalent used in aggregate queries: te.status = 'closed' AND te.approval_status IN ('not_required','approved'))
 */
export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

/** Hours an entry shows: a rejected entry contributes nothing (SPEC 1.12), so nothing summing entries can include it. */
export function shownWorkedMinutes(e: { approval_status: string }, minutes: number | null): number | null {
  return e.approval_status === 'rejected' && minutes !== null ? 0 : minutes;
}

export const countsAsWorked = (e: { status: string; approval_status: string }): boolean =>
  e.status === 'closed' && (e.approval_status === 'not_required' || e.approval_status === 'approved');
