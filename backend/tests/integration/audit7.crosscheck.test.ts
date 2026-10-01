import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DateTime } from 'luxon';
import { setupWorld, World } from '../helpers/fixtures';
import { q, q1 } from '../helpers/db';
import { closePool } from '../../src/db/pool';
import { shiftInstants, overlaps } from '../../src/domain/instants';
import { restGaps } from '../../src/domain/restPeriod';
import { countTimeOffDays } from '../../src/domain/timeOffDays';
import { supplementMinutes } from '../../src/domain/supplements';
import { eachDate, isoWeekday, addDays } from '../../src/domain/dates';

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TZ = 'Europe/Berlin';
let w: World;

describe('audit 7: independent implementations must agree', () => {
  beforeAll(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('overlap: JS instants vs the DB trigger agree on 300 random shift pairs (incl. DST nights)', async () => {
    const r = rng(20261001);
    const dates = ['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-12-30', '2026-12-31'];
    const time = () => {
      const h = Math.floor(r() * 24);
      const m = [0, 15, 30, 45][Math.floor(r() * 4)];
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };
    let disagreements = 0;
    let overlapsSeen = 0;
    for (let i = 0; i < 300; i++) {
      const s1 = time(), s2 = time();
      let e1 = time(), e2 = time();
      while (e1 === s1) e1 = time();
      while (e2 === s2) e2 = time();
      const d1 = dates[Math.floor(r() * dates.length)];
      const d2 = r() < 0.6 ? d1 : r() < 0.5 ? addDays(d1, 1) : addDays(d1, -1);
      const emp = (await q1(`INSERT INTO employees (company_id, first_name, last_name) VALUES ($1,'X','Y') RETURNING id`, [w.companyId])).id;
      await q(`INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home, assigned_on) VALUES ($1,$2,$3,true,'2020-01-01')`, [emp, w.h1, w.companyId]);
      await q(`INSERT INTO employee_departments (employee_id, department_id, hotel_id) VALUES ($1,$2,$3)`, [emp, w.d1, w.h1]);
      const mk = async (s: string, e: string) => (await q1(`INSERT INTO shifts (hotel_id, department_id, name, start_time, end_time, break_duration_minutes) VALUES ($1,$2,$3,$4,$5,0) RETURNING id`, [w.h1, w.d1, `s${i}${s}${e}${Math.random()}`, s, e])).id;
      const a = await mk(s1, e1);
      const b = await mk(s2, e2);
      await q(`INSERT INTO schedules (hotel_id, employee_id, entry_type, shift_id, date) VALUES ($1,$2,'shift',$3,$4)`, [w.h1, emp, a, d1]);
      let dbSaysOverlap = false;
      try {
        await q(`INSERT INTO schedules (hotel_id, employee_id, entry_type, shift_id, date) VALUES ($1,$2,'shift',$3,$4)`, [w.h1, emp, b, d2]);
      } catch (e: any) {
        if (/overlaps another shift/.test(e.message)) dbSaysOverlap = true;
        else throw e;
      }
      const jsSaysOverlap = overlaps(shiftInstants(d1, s1, e1, TZ), shiftInstants(d2, s2, e2, TZ));
      if (jsSaysOverlap) overlapsSeen++;
      if (jsSaysOverlap !== dbSaysOverlap) {
        disagreements++;
        console.log('DISAGREE', { d1, s1, e1, d2, s2, e2, jsSaysOverlap, dbSaysOverlap });
      }
    }
    expect(overlapsSeen).toBeGreaterThan(40); // the sample really exercises both outcomes
    expect(disagreements).toBe(0);
  });

  it('rest gap: JS instants vs SQL AT TIME ZONE arithmetic on random night/day pairs', async () => {
    const r = rng(7);
    for (let i = 0; i < 120; i++) {
      const base = ['2026-03-28', '2026-10-24', '2026-06-10', '2026-12-31'][Math.floor(r() * 4)];
      const h1 = Math.floor(r() * 24), h2 = Math.floor(r() * 24);
      const len1 = 4 + Math.floor(r() * 9);
      const s1 = `${String(h1).padStart(2, '0')}:00`;
      const e1 = `${String((h1 + len1) % 24).padStart(2, '0')}:00`;
      const s2 = `${String(h2).padStart(2, '0')}:00`;
      const e2 = `${String((h2 + 6) % 24).padStart(2, '0')}:00`;
      const prev = { date: base, ...shiftInstants(base, s1, e1, TZ) };
      const day = { date: addDays(base, 1), ...shiftInstants(addDays(base, 1), s2, e2, TZ) };
      const jsGap = restGaps([prev], [day], []).previous!.gapHours;
      const sql = await q1(
        `SELECT EXTRACT(EPOCH FROM (($2::date + $3::time) AT TIME ZONE 'Europe/Berlin') - (($1::date + CASE WHEN $5::time > $4::time THEN 0 ELSE 1 END + $5::time) AT TIME ZONE 'Europe/Berlin'))::float / 3600 AS gap`,
        [base, addDays(base, 1), s2, s1, e1],
      );
      expect(jsGap).toBeCloseTo(sql.gap, 6);
    }
  });

  it('counted days: invariants hold for random ranges, weekdays and holidays', () => {
    const r = rng(99);
    for (let i = 0; i < 500; i++) {
      const start = addDays('2026-01-01', Math.floor(r() * 400));
      const end = addDays(start, Math.floor(r() * 40));
      const weekdays = [1, 2, 3, 4, 5, 6, 7].filter(() => r() < 0.6);
      if (weekdays.length === 0) weekdays.push(1);
      const holidays = new Set(eachDate(start, end).filter(() => r() < 0.1));
      const sh = r() < 0.5, eh = r() < 0.5;
      if (start === end && sh && eh) continue;
      const res = countTimeOffDays({ startDate: start, endDate: end, startHalfDay: sh, endHalfDay: eh, workWeekdays: weekdays, holidayName: (d) => (holidays.has(d) ? 'H' : null) });
      const all = eachDate(start, end);
      const expectedDays = all.filter((d) => weekdays.includes(isoWeekday(d)) && !holidays.has(d));
      expect(res.days.map((d) => d.date)).toEqual(expectedDays);
      expect(res.days.length + res.skipped.length).toBe(all.length);
      let expected = expectedDays.length;
      if (expectedDays.length === 1 && sh && eh) expected = 0; // both flags on the single kept day: first/last are the same day → 0.5 (see below)
      const halves = expectedDays.length === 0 ? 0 : expectedDays.length === 1 ? (sh || eh ? 0.5 : 0) : (sh ? 0.5 : 0) + (eh ? 0.5 : 0);
      if (expectedDays.length === 1 && sh && eh) expected = 1 - 0.5; else expected = expectedDays.length - halves;
      expect(res.total).toBe(expected);
      for (const d of res.days) expect([0.5, 1]).toContain(d.fraction);
    }
  });

  it('supplements: per-minute implementation equals a naive luxon reference on random intervals', () => {
    const r = rng(5);
    const hol = (d: string) => d === '2026-05-14' || d === '2026-10-03';
    for (let i = 0; i < 60; i++) {
      const start = DateTime.fromISO(`2026-${['03-28', '05-13', '10-02', '10-24', '12-24'][Math.floor(r() * 5)]}T00:00`, { zone: TZ }).plus({ minutes: Math.floor(r() * 1440) });
      const gross = 60 + Math.floor(r() * 12 * 60);
      const end = start.plus({ minutes: gross });
      const brk = r() < 0.5 ? 0 : 15 + Math.floor(r() * 45);
      const got = supplementMinutes(start.toJSDate(), end.toJSDate(), TZ, '23:00', '06:00', hol, brk);
      let night = 0, sat = 0, sun = 0, holi = 0;
      for (let m = 0; m < gross; m++) {
        const t = start.plus({ minutes: m }).setZone(TZ);
        const mod = t.hour * 60 + t.minute;
        if (mod >= 23 * 60 || mod < 6 * 60) night++;
        if (t.weekday === 6) sat++;
        if (t.weekday === 7) sun++;
        if (hol(t.toISODate()!)) holi++;
      }
      const f = brk > 0 ? Math.max(0, gross - brk) / gross : 1;
      expect(got.nightMinutes).toBeCloseTo(night * f, 6);
      expect(got.saturdayMinutes).toBeCloseTo(sat * f, 6);
      expect(got.sundayMinutes).toBeCloseTo(sun * f, 6);
      expect(got.holidayMinutes).toBeCloseTo(holi * f, 6);
    }
  });
});

describe('audit 7b: local time → instant matches PostgreSQL exhaustively around both clock changes', () => {
  beforeAll(async () => {
    w = await setupWorld();
  });

  it('every 15-minute wall-clock time on 27–31 Mar and 23–27 Oct 2026 resolves identically in JS and PostgreSQL', async () => {
    const { zonedInstant } = await import('../../src/domain/instants');
    const days = ['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
    const locals: string[] = [];
    for (const d of days) for (let m = 0; m < 1440; m += 15) locals.push(`${d}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    const pg = await q(`SELECT l, (replace(l, 'T', ' ')::timestamp AT TIME ZONE 'Europe/Berlin') AS instant FROM unnest($1::text[]) AS l`, [locals]);
    const bad = pg.filter((r) => zonedInstant(r.l, 'Europe/Berlin').getTime() !== new Date(r.instant).getTime()).map((r) => r.l);
    expect(bad).toEqual([]);
    expect(pg).toHaveLength(960);
  });

  it('a night shift that ends inside the repeated hour is consistent with the database trigger', async () => {
    const emp = (await q1(`INSERT INTO employees (company_id, first_name, last_name) VALUES ($1,'N','S') RETURNING id`, [w.companyId])).id;
    await q(`INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home, assigned_on) VALUES ($1,$2,$3,true,'2020-01-01')`, [emp, w.h1, w.companyId]);
    await q(`INSERT INTO employee_departments (employee_id, department_id, hotel_id) VALUES ($1,$2,$3)`, [emp, w.d1, w.h1]);
    const a = (await q1(`INSERT INTO shifts (hotel_id, department_id, name, start_time, end_time, break_duration_minutes) VALUES ($1,$2,'late-night','18:00','02:30',30) RETURNING id`, [w.h1, w.d1])).id;
    const b = (await q1(`INSERT INTO shifts (hotel_id, department_id, name, start_time, end_time, break_duration_minutes) VALUES ($1,$2,'after','02:00','06:00',0) RETURNING id`, [w.h1, w.d1])).id;
    await q(`INSERT INTO schedules (hotel_id, employee_id, entry_type, shift_id, date) VALUES ($1,$2,'shift',$3,'2026-10-24')`, [w.h1, emp, a]);
    // 02:30 (second occurrence, CET) ends at 01:30Z; a shift starting 02:00 on the 25th (second 02:00 CET = 01:00Z) overlaps by 30 min
    const js = overlaps(shiftInstants('2026-10-24', '18:00', '02:30', TZ), shiftInstants('2026-10-25', '02:00', '06:00', TZ));
    let db = false;
    try {
      await q(`INSERT INTO schedules (hotel_id, employee_id, entry_type, shift_id, date) VALUES ($1,$2,'shift',$3,'2026-10-25')`, [w.h1, emp, b]);
    } catch (e: any) {
      db = /overlaps another shift/.test(e.message);
    }
    expect(js).toBe(true);
    expect(db).toBe(true);
  });
});
