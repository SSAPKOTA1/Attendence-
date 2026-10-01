import { addDays, isoWeek, weekDays, weekStart, windows, fmtMinutes } from '../../src/lib/format';
import { instantToLocal, localToInstant } from '../../src/lib/zone';

describe('date helpers', () => {
  it('weeks start on Monday and never drift over month/year/DST edges', () => {
    expect(weekStart('2026-10-01')).toBe('2026-09-28'); // Thursday
    expect(weekStart('2026-09-28')).toBe('2026-09-28');
    expect(weekStart('2026-10-04')).toBe('2026-09-28'); // Sunday belongs to the week before
    expect(weekDays('2026-10-26')).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('ISO week numbers', () => {
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(isoWeek('2026-10-01')).toBe(40);
    expect(isoWeek('2026-12-31')).toBe(53);
  });
  it('splits long ranges into API-sized windows', () => {
    const w = windows('2026-10-01', 3);
    expect(w[0]).toEqual({ from: '2026-10-01', to: '2026-12-01' });
    expect(w[1].from).toBe('2026-12-02');
    expect(w).toHaveLength(3);
  });
  it('formats minutes', () => {
    expect(fmtMinutes(453)).toBe('7:33 h');
    expect(fmtMinutes(null)).toBe('–');
  });
});

describe('hotel-local datetime <-> instant', () => {
  it('summer time (UTC+2)', () => {
    expect(localToInstant('2026-10-05T06:00', 'Europe/Berlin')).toBe('2026-10-05T04:00:00.000Z');
    expect(instantToLocal('2026-10-05T04:00:00.000Z', 'Europe/Berlin')).toBe('2026-10-05T06:00');
  });
  it('winter time (UTC+1)', () => {
    expect(localToInstant('2026-12-05T06:00', 'Europe/Berlin')).toBe('2026-12-05T05:00:00.000Z');
  });
  it('round-trips around the autumn change (2026-10-25)', () => {
    for (const v of ['2026-10-25T01:30', '2026-10-25T03:30', '2026-10-24T23:00', '2026-10-25T04:00']) {
      expect(instantToLocal(localToInstant(v, 'Europe/Berlin'), 'Europe/Berlin')).toBe(v);
    }
    expect(localToInstant('2026-10-25T01:30', 'Europe/Berlin')).toBe('2026-10-24T23:30:00.000Z'); // still summer time
    expect(localToInstant('2026-10-25T03:30', 'Europe/Berlin')).toBe('2026-10-25T02:30:00.000Z'); // winter time
    expect(localToInstant('2026-10-25T02:30', 'Europe/Berlin')).toBe('2026-10-25T01:30:00.000Z'); // repeated hour: later occurrence
  });
  it('other zones work too', () => {
    expect(localToInstant('2026-10-05T12:00', 'UTC')).toBe('2026-10-05T12:00:00.000Z');
  });
});
