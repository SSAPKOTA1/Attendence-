import { eachDate, isoWeekday } from './dates';

export interface CountedDay {
  date: string;
  fraction: number;
}

export interface SkippedDay {
  date: string;
  reason: 'non_working_day' | 'public_holiday';
  name?: string;
}

/**
 * R8: keep a date only if its ISO weekday is a work weekday and it is not a public holiday (home hotel region).
 * startHalfDay / endHalfDay make the first / last kept day 0.5.
 */
export function countTimeOffDays(input: {
  startDate: string;
  endDate: string;
  startHalfDay?: boolean;
  endHalfDay?: boolean;
  workWeekdays: number[];
  holidayName: (date: string) => string | null;
}): { days: CountedDay[]; skipped: SkippedDay[]; total: number } {
  const days: CountedDay[] = [];
  const skipped: SkippedDay[] = [];
  for (const date of eachDate(input.startDate, input.endDate)) {
    if (!input.workWeekdays.includes(isoWeekday(date))) {
      skipped.push({ date, reason: 'non_working_day' });
      continue;
    }
    const holiday = input.holidayName(date);
    if (holiday) {
      skipped.push({ date, reason: 'public_holiday', name: holiday });
      continue;
    }
    days.push({ date, fraction: 1 });
  }
  if (days.length > 0) {
    if (input.startHalfDay) days[0].fraction = 0.5;
    if (input.endHalfDay) days[days.length - 1].fraction = 0.5;
  }
  const total = days.reduce((s, d) => s + d.fraction, 0);
  return { days, skipped, total };
}
