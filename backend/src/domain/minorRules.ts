import { daySpanHours, gapsBetweenParts, TimedShift } from './restPeriod';
import { hoursBetween } from './instants';

export interface MinorSettings {
  maxDailyHours: number;
  maxWeeklyHours: number;
  maxDaysPerWeek: number;
  maxShiftSpanHours: number;
  minRestHours: number;
  earliestStart: string;
  latestEnd: string;
  latestEndHospitality16Plus: string;
  breakRules: { workingOverHours: number; minMinutes: number }[];
}

export interface MinorShift extends TimedShift {
  startTime: string;
  endTime: string;
  paidMinutes: number;
  breakMinutes: number;
}

export interface MinorViolation {
  rule:
    | 'daily_limit'
    | 'weekly_limit'
    | 'days_per_week'
    | 'shift_span'
    | 'rest_period'
    | 'earliest_start'
    | 'latest_end'
    | 'night_work'
    | 'break';
  limit: number | string;
  actual: number | string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** R18 rules for an employee under 18 on the day. Pure: the caller supplies the day / week context. */
export function evaluateMinorRules(input: {
  age: number;
  settings: MinorSettings;
  dayShifts: MinorShift[];
  weekWorkMinutes: number;
  weekSchoolCreditMinutes: number;
  weekShiftDays: number;
  prevDayLastEnd: Date | null;
  nextDayFirstStart: Date | null;
}): MinorViolation[] {
  const s = input.settings;
  const out: MinorViolation[] = [];
  const day = input.dayShifts;
  if (day.length === 0) return out;
  const dayWork = day.reduce((a, x) => a + x.paidMinutes, 0);
  if (dayWork > s.maxDailyHours * 60) out.push({ rule: 'daily_limit', limit: s.maxDailyHours, actual: r2(dayWork / 60) });
  const week = input.weekWorkMinutes + input.weekSchoolCreditMinutes;
  if (week > s.maxWeeklyHours * 60) out.push({ rule: 'weekly_limit', limit: s.maxWeeklyHours, actual: r2(week / 60) });
  if (input.weekShiftDays > s.maxDaysPerWeek) out.push({ rule: 'days_per_week', limit: s.maxDaysPerWeek, actual: input.weekShiftDays });
  const span = daySpanHours(day);
  if (span > s.maxShiftSpanHours) out.push({ rule: 'shift_span', limit: s.maxShiftSpanHours, actual: r2(span) });
  const firstStart = new Date(Math.min(...day.map((x) => x.start.getTime())));
  const lastEnd = new Date(Math.max(...day.map((x) => x.end.getTime())));
  const rests = [
    input.prevDayLastEnd ? hoursBetween(input.prevDayLastEnd, firstStart) : null,
    input.nextDayFirstStart ? hoursBetween(lastEnd, input.nextDayFirstStart) : null,
  ].filter((x): x is number => x !== null);
  if (rests.length && Math.min(...rests) < s.minRestHours) {
    out.push({ rule: 'rest_period', limit: s.minRestHours, actual: r2(Math.min(...rests)) });
  }
  const earliest = day.map((x) => x.startTime).sort()[0];
  if (earliest < s.earliestStart) out.push({ rule: 'earliest_start', limit: s.earliestStart, actual: earliest });
  const latestAllowed = input.age >= 16 ? s.latestEndHospitality16Plus : s.latestEnd;
  const crossing = day.filter((x) => x.endTime <= x.startTime);
  if (crossing.length > 0) {
    out.push({ rule: 'night_work', limit: '00:00', actual: crossing[0].endTime });
    out.push({ rule: 'latest_end', limit: latestAllowed, actual: crossing[0].endTime });
  } else {
    const latest = day.map((x) => x.endTime).sort().reverse()[0];
    if (latest > latestAllowed) out.push({ rule: 'latest_end', limit: latestAllowed, actual: latest });
  }
  // breaks count only in blocks of >= 15 minutes; gaps between split parts count
  const breakCounted =
    day.reduce((a, x) => a + (x.breakMinutes >= 15 ? x.breakMinutes : 0), 0) +
    gapsBetweenParts(day).filter((g) => g >= 15).reduce((a, g) => a + g, 0);
  let required = 0;
  for (const rule of s.breakRules) if (dayWork > rule.workingOverHours * 60) required = Math.max(required, rule.minMinutes);
  if (breakCounted < required) out.push({ rule: 'break', limit: required, actual: Math.round(breakCounted) });
  return out;
}
