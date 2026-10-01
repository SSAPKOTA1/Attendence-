import { describe, it, expect } from 'vitest';
import { durationMinutes, paidMinutes, requiredBreak, toHours } from '../../src/domain/hours';
import { shiftInstants, overlaps, hoursBetween } from '../../src/domain/instants';
import { restGaps, daySpanHours, gapsBetweenParts } from '../../src/domain/restPeriod';
import { ageOn, addDays, isoWeekday, weekStart, weekEnd, monthEnd, eachMonth, localDate } from '../../src/domain/dates';
import { countTimeOffDays } from '../../src/domain/timeOffDays';
import { remainingVacation, statutoryMinimumForMinor } from '../../src/domain/vacation';
import { evaluateMinorRules } from '../../src/domain/minorRules';
import { autoBreakMinutes, clockInAnomalies, clockOutAnomalies, workedMinutes } from '../../src/domain/anomalies';
import { bradfordFactor, mergeSpells } from '../../src/domain/bradford';
import { adjustedMonthlyTarget, balanceHours, monthDelta } from '../../src/domain/timeAccount';
import { supplementMinutes } from '../../src/domain/supplements';
import { displayName } from '../../src/domain/names';
import { DEFAULT_SETTINGS, SettingsSchema, effectiveSettings } from '../../src/domain/settings';
import { stripPii } from '../../src/services/audit';
import { toCsv } from '../../src/domain/csv';

const TZ = 'Europe/Berlin';

describe('hours (R1)', () => {
  it('wraps midnight and subtracts the unpaid break', () => {
    expect(durationMinutes('22:00', '06:00')).toBe(480);
    expect(durationMinutes('06:00', '14:00')).toBe(480);
    expect(paidMinutes(480, 60)).toBe(420);
    expect(toHours(450)).toBe(7.5);
    expect(toHours(100)).toBe(1.67);
  });
  it('break rules: largest applicable rule wins', () => {
    const rules = [{ overHours: 6, minMinutes: 30 }, { overHours: 9, minMinutes: 45 }];
    expect(requiredBreak(360, rules)).toBe(0);
    expect(requiredBreak(361, rules)).toBe(30);
    expect(requiredBreak(600, rules)).toBe(45);
  });
});

describe('instants and rest periods on clock-change nights (R4)', () => {
  it('a nominal 22:00–06:00 shift lasts 9 h on 25 Oct 2026 and 7 h on 29 Mar 2026', () => {
    const autumn = shiftInstants('2026-10-24', '22:00', '06:00', TZ);
    expect(hoursBetween(autumn.start, autumn.end)).toBe(9);
    const spring = shiftInstants('2026-03-28', '22:00', '06:00', TZ);
    expect(hoursBetween(spring.start, spring.end)).toBe(7);
  });
  it('gap between previous day last end and the day first start', () => {
    const late = { date: '2026-10-05', ...shiftInstants('2026-10-05', '14:00', '22:00', TZ) };
    const early = { date: '2026-10-06', ...shiftInstants('2026-10-06', '06:00', '14:00', TZ) };
    const r = restGaps([late], [early], []);
    expect(r.previous!.gapHours).toBe(8);
    expect(r.restPeriodHours).toBe(8);
    const night = { date: '2026-10-24', ...shiftInstants('2026-10-24', '22:00', '06:00', TZ) };
    const nine = { date: '2026-10-25', ...shiftInstants('2026-10-25', '09:00', '17:00', TZ) };
    expect(restGaps([night], [nine], []).restPeriodHours).toBe(3);
  });
  it('split parts of the same day are not a rest period', () => {
    const a = { date: '2026-10-05', ...shiftInstants('2026-10-05', '06:00', '10:00', TZ) };
    const b = { date: '2026-10-05', ...shiftInstants('2026-10-05', '17:00', '21:00', TZ) };
    expect(restGaps([], [a, b], []).restPeriodHours).toBeNull();
    expect(daySpanHours([a, b])).toBe(15);
    expect(gapsBetweenParts([b, a])).toEqual([420]);
    expect(overlaps(a, b)).toBe(false);
  });
});

describe('calendar', () => {
  it('weeks are Monday–Sunday, months calendar months', () => {
    expect(weekStart('2026-10-01')).toBe('2026-09-28');
    expect(weekEnd('2026-10-01')).toBe('2026-10-04');
    expect(isoWeekday('2026-10-04')).toBe(7);
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(eachMonth('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
  it('age ends on the birthday', () => {
    expect(ageOn('2008-10-07', '2026-10-06')).toBe(17);
    expect(ageOn('2008-10-07', '2026-10-07')).toBe(18);
  });
  it('local date of an instant', () => {
    expect(localDate(new Date('2026-09-30T22:30:00Z'), TZ)).toBe('2026-10-01');
  });
});

describe('counted days (R8)', () => {
  const noHolidays = () => null;
  it('skips non-working weekdays and holidays, applies half days', () => {
    const r = countTimeOffDays({ startDate: '2026-12-21', endDate: '2026-12-27', workWeekdays: [1, 2, 3, 4, 5], holidayName: (d) => (d === '2026-12-25' ? 'Christmas' : null), startHalfDay: true });
    expect(r.days.map((d) => d.date)).toEqual(['2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24']);
    expect(r.days[0].fraction).toBe(0.5);
    expect(r.total).toBe(3.5);
    expect(r.skipped.map((s) => s.reason)).toEqual(['public_holiday', 'non_working_day', 'non_working_day']);
  });
  it('zero counted days', () => {
    expect(countTimeOffDays({ startDate: '2026-10-10', endDate: '2026-10-11', workWeekdays: [1, 2, 3, 4, 5], holidayName: noHolidays }).total).toBe(0);
  });
});

describe('vacation (R9)', () => {
  it('carry-over lapses after its expiry date', () => {
    const base = { vacationDaysPerYear: 30, carriedOverDays: 5, carryOverExpiresOn: '2026-03-31', usedDays: 10, usedOnOrBeforeExpiry: 2 };
    expect(remainingVacation({ ...base, today: '2026-03-01' })).toBe(25);
    expect(remainingVacation({ ...base, today: '2026-04-01' })).toBe(22);
    expect(remainingVacation({ ...base, carryOverExpiresOn: null, today: '2026-10-01' })).toBe(25);
  });
  it('JArbSchG minimum by age at year start', () => {
    expect(statutoryMinimumForMinor(15, 5)).toBe(25);
    expect(statutoryMinimumForMinor(16, 5)).toBe(23);
    expect(statutoryMinimumForMinor(17, 6)).toBe(25);
    expect(statutoryMinimumForMinor(18, 5)).toBeNull();
  });
});

describe('minor rules (R18)', () => {
  const s = DEFAULT_SETTINGS.legal.minors;
  const sh = (date: string, start: string, end: string, brk: number) => {
    const inst = shiftInstants(date, start, end, TZ);
    return { date, ...inst, startTime: start, endTime: end, breakMinutes: brk, paidMinutes: durationMinutes(start, end) - brk };
  };
  const base = { age: 17, settings: s, weekWorkMinutes: 0, weekSchoolCreditMinutes: 0, weekShiftDays: 1, prevDayLastEnd: null, nextDayFirstStart: null };
  it('clean 8 h day', () => {
    expect(evaluateMinorRules({ ...base, dayShifts: [sh('2026-10-05', '08:00', '17:00', 60)], weekWorkMinutes: 480 })).toEqual([]);
  });
  it('daily, break, night and time windows', () => {
    const v = evaluateMinorRules({ ...base, dayShifts: [sh('2026-10-05', '05:00', '15:00', 30)], weekWorkMinutes: 570 });
    expect(v.map((x) => x.rule).sort()).toEqual(['break', 'daily_limit', 'earliest_start']);
    const night = evaluateMinorRules({ ...base, dayShifts: [sh('2026-10-05', '20:00', '02:00', 30)], weekWorkMinutes: 330 });
    expect(night.map((x) => x.rule)).toEqual(expect.arrayContaining(['night_work', 'latest_end']));
    const fifteen = evaluateMinorRules({ ...base, age: 15, dayShifts: [sh('2026-10-05', '13:00', '21:00', 60)], weekWorkMinutes: 420 });
    expect(fifteen).toEqual([{ rule: 'latest_end', limit: '20:00', actual: '21:00' }]);
  });
  it('split-day gaps count as breaks; week limits include school', () => {
    const v = evaluateMinorRules({ ...base, dayShifts: [sh('2026-10-05', '08:00', '11:30', 0), sh('2026-10-05', '12:30', '16:00', 0)], weekWorkMinutes: 420 });
    expect(v).toEqual([]);
    const week = evaluateMinorRules({ ...base, dayShifts: [sh('2026-10-09', '08:00', '12:00', 0)], weekWorkMinutes: 2160, weekSchoolCreditMinutes: 480, weekShiftDays: 6 });
    expect(week.map((x) => x.rule)).toEqual(['weekly_limit', 'days_per_week']);
  });
});

describe('attendance anomalies and breaks (R13)', () => {
  const start = new Date('2026-10-01T04:00:00Z');
  it('early / late / unscheduled', () => {
    const cfg = { earlyClockInMinutes: 30, lateToleranceMinutes: 5 };
    expect(clockInAnomalies(new Date('2026-10-01T03:15:00Z'), { start }, cfg)).toEqual([{ type: 'early_clock_in', minutes: 45 }]);
    expect(clockInAnomalies(new Date('2026-10-01T04:05:00Z'), { start }, cfg)).toEqual([]);
    expect(clockInAnomalies(new Date('2026-10-01T04:06:00Z'), { start }, cfg)).toEqual([{ type: 'late_clock_in', minutes: 6 }]);
    expect(clockInAnomalies(start, null, cfg)).toEqual([{ type: 'unscheduled_work' }]);
  });
  it('early clock-out / overtime', () => {
    const end = new Date('2026-10-01T12:00:00Z');
    const cfg = { lateToleranceMinutes: 5, overtimeToleranceMinutes: 15 };
    expect(clockOutAnomalies(new Date('2026-10-01T11:00:00Z'), { end }, cfg)).toEqual([{ type: 'early_clock_out', minutes: 60 }]);
    expect(clockOutAnomalies(new Date('2026-10-01T12:30:00Z'), { end }, cfg)).toEqual([{ type: 'overtime', minutes: 30 }]);
  });
  it('auto break', () => {
    const rules = DEFAULT_SETTINGS.legal.breakRules;
    expect(autoBreakMinutes(480, 30, rules)).toBe(30);
    expect(autoBreakMinutes(240, 30, rules)).toBe(0);
    expect(autoBreakMinutes(600, null, rules)).toBe(45);
    expect(autoBreakMinutes(300, null, rules)).toBe(0);
    expect(workedMinutes(new Date('2026-10-05T04:02:03Z'), new Date('2026-10-05T12:05:40Z'), 30)).toBe(453);
  });
});

describe('analytics helpers', () => {
  it('Bradford factor and spell merging', () => {
    expect(bradfordFactor(3, 6)).toBe(54);
    const spells = mergeSpells(
      [
        { startDate: '2026-09-01', endDate: '2026-09-02' },
        { startDate: '2026-09-03', endDate: '2026-09-03' },
        { startDate: '2026-09-10', endDate: '2026-09-10' },
      ],
      addDays,
    );
    expect(spells.map((s) => s.length)).toEqual([2, 1]);
  });
  it('time account', () => {
    expect(monthDelta(900, 480, 9600)).toBe(-8220);
    expect(adjustedMonthlyTarget(160, 22, 1)).toBeCloseTo(9163.64, 1);
    expect(balanceHours(10, [-8220, -9163.636])).toBe(-279.73);
  });
  it('night / Saturday / Sunday / holiday minutes per local minute', () => {
    const m = supplementMinutes(new Date('2026-05-02T20:00:00Z'), new Date('2026-05-03T04:00:00Z'), TZ, '23:00', '06:00', () => false);
    expect(m.nightMinutes).toBe(420);
    expect(m.saturdayMinutes).toBe(120);
    expect(m.sundayMinutes).toBe(360);
    // the break is deducted automatically (proportionally): 60 min break on 480 min gross
    const withBreak = supplementMinutes(new Date('2026-05-02T20:00:00Z'), new Date('2026-05-03T04:00:00Z'), TZ, '23:00', '06:00', () => true, 60);
    expect(withBreak).toEqual({ nightMinutes: 367.5, saturdayMinutes: 105, sundayMinutes: 315, holidayMinutes: 420 });
    const dst = supplementMinutes(new Date('2026-10-24T20:00:00Z'), new Date('2026-10-25T05:00:00Z'), TZ, '23:00', '06:00', () => false);
    expect(dst.nightMinutes).toBe(480);
  });
});

describe('misc', () => {
  it('display names', () => {
    expect(displayName('Maria', 'Garcia')).toBe('Maria G.');
    expect(displayName('Maria', 'Garcia', 'full')).toBe('Maria Garcia');
  });
  it('settings defaults and strict validation', () => {
    expect(effectiveSettings({ roster: { maxShiftsPerDay: 3 } }).roster).toMatchObject({ maxShiftsPerDay: 3, changeNoticeHours: 72 });
    expect(DEFAULT_SETTINGS.legal.minors.enforcement).toBe('warn');
    expect(SettingsSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });
  it('PII is stripped recursively from audit payloads', () => {
    expect(stripPii({ firstName: 'A', nested: [{ email: 'x', status: 'ok', hourly_rate: 3 }], pin: '1' })).toEqual({ nested: [{ status: 'ok' }] });
  });
  it('CSV quoting', () => {
    expect(toCsv(['a', 'b'], [{ a: 'x,y', b: 'q"uote' }])).toBe('a,b\r\n"x,y","q""uote"\r\n');
  });
});

describe('config safety', () => {
  it('refuses TRUST_PROXY=true (spoofable client IP)', async () => {
    const { execFileSync } = await import('node:child_process');
    const run = (v: string) =>
      execFileSync(process.execPath, ['-e', "require('tsx/cjs'); require('./src/config')"], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test', TRUST_PROXY: v },
        stdio: 'pipe',
      });
    expect(() => run('true')).toThrow(/TRUST_PROXY/);
    expect(() => run('1')).not.toThrow();
    expect(() => run('loopback')).not.toThrow();
  });
});
