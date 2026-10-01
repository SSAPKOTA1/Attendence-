import { Db, maybeOne, rows } from '../../db/pool';
import { AppError } from '../../errors/AppError';
import type { AuthContext } from '../../types/context';
import { addDays, ageOn, isoWeekday, maxDate, minDate, monthEnd, monthStart, todayIn, weekEnd, weekStart } from '../../domain/dates';
import { dayStart, hoursBetween, overlaps, shiftInstants } from '../../domain/instants';
import { durationMinutes, toHours } from '../../domain/hours';
import { daySpanHours, restGaps } from '../../domain/restPeriod';
import { evaluateMinorRules, MinorShift, MinorViolation } from '../../domain/minorRules';
import { now } from '../../clock';
import { Hotel, loadHotel } from '../access';
import { loadTargets, WorkTargets } from '../employees';
import { creditsFor } from '../credits';
import { holidayName } from '../holidays';
import { Entry, loadEmployeeEntries } from './entries';

export interface EntryInput {
  hotelId: number;
  entryType: 'shift' | 'off';
  employeeId: number;
  shiftId?: number | null;
  date: string;
  offLabel?: string | null;
  overrideReason?: string | null;
  allowPast?: boolean;
}

export type EvalMode = 'create' | 'update' | 'validate' | 'candidate' | 'publish';

export interface Warning {
  type: string;
  severity: 'warning' | 'info';
  message: string;
  [k: string]: unknown;
}

export interface Evaluation {
  hotel: Hotel;
  employee: any;
  shift: any | null;
  proposed: Entry;
  warnings: Warning[];
  minorViolations: MinorViolation[];
  isMinor: boolean;
  targets: WorkTargets;
  paidMinutes: number;
  weekMinutes: number;
  weekMinutesBefore: number;
  monthMinutes: number;
  restPeriodHours: number | null;
  shortNotice: boolean;
}

const t = (lang: 'de' | 'en', en: string, de: string) => (lang === 'de' ? de : en);

function fmtH(h: number) {
  return Math.round(h * 100) / 100;
}

/**
 * Runs every hard block (R2) and soft warning (R3, R18) for a roster entry without writing anything.
 * Used by create, patch, validate, bulk, copy, publish and the cover finder.
 */
export async function evaluateEntry(
  db: Db,
  ctx: AuthContext,
  input: EntryInput,
  opts: { mode: EvalMode; existing?: Entry | null; skipPast?: boolean },
): Promise<Evaluation> {
  const lang = ctx.lang;
  const hotel = await loadHotel(db, input.hotelId);
  const settings = hotel.settings;
  if (input.entryType === 'shift' && !input.shiftId) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'shiftId', issue: 'required for shift entries' }] });
  }
  if (input.entryType === 'off' && input.shiftId) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'shiftId', issue: 'must be empty for off entries' }] });
  }
  const employee = await maybeOne(db, 'SELECT * FROM employees WHERE id = $1 AND deleted_at IS NULL', [input.employeeId]);
  if (!employee || employee.company_id !== hotel.companyId) {
    throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'employeeId', issue: 'not found' }] });
  }
  let shift: any = null;
  if (input.entryType === 'shift') {
    shift = await maybeOne(db, 'SELECT * FROM shifts WHERE id = $1 AND hotel_id = $2 AND deleted_at IS NULL', [input.shiftId, hotel.id]);
    if (!shift) throw new AppError('RESOURCE_NOT_FOUND', { details: [{ field: 'shiftId', issue: 'not found in this hotel' }] });
  }
  const date = input.date;
  const today = todayIn(hotel.timezone, now());
  if (!opts.skipPast && date < today && !(ctx.role === 'admin' && input.allowPast)) throw new AppError('SCHEDULE_DATE_IN_PAST');
  if (employee.status === 'terminated' || (employee.terminated_on && employee.terminated_on < date)) throw new AppError('EMPLOYEE_INACTIVE');
  const assigned = await maybeOne(
    db,
    'SELECT 1 FROM employee_hotels WHERE employee_id = $1 AND hotel_id = $2 AND (unassigned_on IS NULL OR unassigned_on >= $3::date)',
    [employee.id, hotel.id, date],
  );
  if (!assigned) throw new AppError('EMPLOYEE_NOT_ASSIGNED_TO_HOTEL');
  const approvedAbsence = await maybeOne(
    db,
    `SELECT id FROM time_offs WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2 AND end_date >= $2 LIMIT 1`,
    [employee.id, date],
  );
  if (approvedAbsence) throw new AppError('EMPLOYEE_ON_TIME_OFF');
  if (shift) {
    const inDept = await maybeOne(db, 'SELECT 1 FROM employee_departments WHERE employee_id = $1 AND department_id = $2', [employee.id, shift.department_id]);
    if (!inDept) throw new AppError('EMPLOYEE_NOT_IN_DEPARTMENT');
  }

  const wStart = weekStart(date);
  const wEnd = weekEnd(date);
  const mStart = monthStart(date);
  const mEnd = monthEnd(date);
  const windowFrom = addDays(minDate(wStart, mStart), -1);
  const windowTo = addDays(maxDate(wEnd, mEnd), 1);
  const others = (await loadEmployeeEntries(db, employee.id, windowFrom, windowTo)).filter((e) => e.id !== opts.existing?.id);
  const sameDay = others.filter((e) => e.date === date);

  if (input.entryType === 'off') {
    if (sameDay.length > 0) throw new AppError('EMPLOYEE_ALREADY_SCHEDULED', { details: [{ field: 'date', issue: 'a day off excludes any other entry that day' }] });
  } else {
    if (sameDay.some((e) => e.entryType === 'off')) throw new AppError('EMPLOYEE_ALREADY_SCHEDULED', { details: [{ field: 'date', issue: 'the employee has a day off' }] });
    if (sameDay.some((e) => e.shiftId === shift.id)) throw new AppError('EMPLOYEE_ALREADY_SCHEDULED', { details: [{ field: 'shiftId', issue: 'same shift already assigned' }] });
  }

  const inst = shift
    ? shiftInstants(date, shift.start_time, shift.end_time, hotel.timezone)
    : { start: dayStart(date, hotel.timezone), end: dayStart(date, hotel.timezone) };
  const duration = shift ? durationMinutes(shift.start_time, shift.end_time) : 0;
  const brk = shift ? shift.break_duration_minutes : 0;
  const deptName = shift ? (await maybeOne(db, 'SELECT name FROM departments WHERE id = $1', [shift.department_id]))?.name ?? null : null;
  const proposed: Entry = {
    id: opts.existing?.id ?? 0,
    hotelId: hotel.id,
    hotelName: hotel.name,
    timezone: hotel.timezone,
    employeeId: employee.id,
    entryType: input.entryType,
    shiftId: shift?.id ?? null,
    shiftName: shift?.name ?? null,
    departmentId: shift?.department_id ?? null,
    departmentName: deptName,
    startTime: shift?.start_time ?? null,
    endTime: shift?.end_time ?? null,
    breakMinutes: brk,
    durationMinutes: duration,
    paidMinutes: duration - brk,
    date,
    status: opts.existing?.status ?? 'draft',
    offLabel: input.entryType === 'off' ? input.offLabel ?? null : null,
    warnings: [],
    overrideReason: input.overrideReason ?? null,
    publishedAt: opts.existing?.publishedAt ?? null,
    updatedAt: opts.existing?.updatedAt ?? null,
    start: inst.start,
    end: inst.end,
  };

  if (shift) {
    const neighbours = others.filter((e) => e.entryType === 'shift' && e.date >= addDays(date, -1) && e.date <= addDays(date, 1));
    const clash = neighbours.find((e) => overlaps(e, proposed));
    if (clash) {
      throw new AppError('SHIFT_OVERLAPS_EXISTING', {
        details: [{ scheduleId: clash.id, date: clash.date, shiftName: clash.shiftName, hotelName: clash.hotelName, startTime: clash.startTime, endTime: clash.endTime }],
      });
    }
    const dayShiftCount = sameDay.filter((e) => e.entryType === 'shift').length + 1;
    if (dayShiftCount > settings.roster.maxShiftsPerDay) {
      throw new AppError('MAX_SHIFTS_PER_DAY_EXCEEDED', { details: [{ field: 'date', limit: settings.roster.maxShiftsPerDay, actual: dayShiftCount }] });
    }
  }

  const all = [...others, proposed];
  const shiftsOf = (d: string) => all.filter((e) => e.entryType === 'shift' && e.date === d);
  const sumPaid = (list: Entry[]) => list.reduce((a, e) => a + (e.entryType === 'shift' ? e.paidMinutes : 0), 0);
  const weekEntries = all.filter((e) => e.date >= wStart && e.date <= wEnd);
  const weekMinutes = sumPaid(weekEntries);
  const weekMinutesBefore = weekMinutes - proposed.paidMinutes;
  const monthMinutes = sumPaid(all.filter((e) => e.date >= mStart && e.date <= mEnd));
  const targets = await loadTargets(db, employee.id);
  const warnings: Warning[] = [];

  // ---- rest period (R4) and day span ----
  let restPeriodHours: number | null = null;
  const dayShifts = shiftsOf(date);
  if (shift) {
    const rest = restGaps(shiftsOf(addDays(date, -1)), dayShifts, shiftsOf(addDays(date, 1)));
    restPeriodHours = rest.restPeriodHours;
    const min = settings.legal.restPeriodMinHours;
    if (rest.previous && rest.previous.gapHours < min) {
      const n = rest.previous.neighbour;
      warnings.push({
        type: 'insufficient_rest_period',
        severity: 'warning',
        message: t(lang, `Only ${fmtH(rest.previous.gapHours)} hours since previous shift (recommended minimum: ${min})`, `Nur ${fmtH(rest.previous.gapHours)} Stunden seit der vorherigen Schicht (Minimum: ${min})`),
        gapHours: fmtH(rest.previous.gapHours),
        previousShift: { date: n.date, shiftName: n.shiftName, endTime: n.endTime, hotelName: n.hotelName },
      });
    }
    if (rest.next && rest.next.gapHours < min) {
      const n = rest.next.neighbour;
      warnings.push({
        type: 'insufficient_rest_period',
        severity: 'warning',
        message: t(lang, `Only ${fmtH(rest.next.gapHours)} hours until the next shift (recommended minimum: ${min})`, `Nur ${fmtH(rest.next.gapHours)} Stunden bis zur nächsten Schicht (Minimum: ${min})`),
        gapHours: fmtH(rest.next.gapHours),
        nextShift: { date: n.date, shiftName: n.shiftName, startTime: n.startTime, hotelName: n.hotelName },
      });
    }
    const dayPaid = sumPaid(dayShifts);
    if (settings.legal.limitMode === 'daily' && dayPaid > settings.legal.dailyMaxHours * 60) {
      warnings.push({
        type: 'exceeds_daily_max',
        severity: 'warning',
        message: t(lang, `${toHours(dayPaid)} hours on this day exceed the daily maximum of ${settings.legal.dailyMaxHours}`, `${toHours(dayPaid)} Stunden an diesem Tag überschreiten das Tagesmaximum von ${settings.legal.dailyMaxHours}`),
        actualHours: toHours(dayPaid),
        limitHours: settings.legal.dailyMaxHours,
      });
    }
    if (dayShifts.length >= 2) {
      const span = daySpanHours(dayShifts);
      if (span > settings.roster.maxDaySpanHours) {
        warnings.push({
          type: 'split_shift_span',
          severity: 'info',
          message: t(lang, `The day spans ${fmtH(span)} hours from first start to last end`, `Der Tag erstreckt sich über ${fmtH(span)} Stunden`),
          spanHours: fmtH(span),
          limitHours: settings.roster.maxDaySpanHours,
        });
      }
    }
  }

  // ---- weekly / monthly limits and targets ----
  if (settings.legal.limitMode === 'weekly' && weekMinutes > settings.legal.weeklyMaxHours * 60) {
    warnings.push({
      type: 'exceeds_legal_weekly_max',
      severity: 'warning',
      message: t(lang, `${toHours(weekMinutes)} hours this week exceed the legal weekly maximum of ${settings.legal.weeklyMaxHours}`, `${toHours(weekMinutes)} Stunden überschreiten das gesetzliche Wochenmaximum von ${settings.legal.weeklyMaxHours}`),
      actualHours: toHours(weekMinutes),
      limitHours: settings.legal.weeklyMaxHours,
    });
  }
  const periodWarnings = (period: 'week' | 'month', minutes: number, target: number, max: number, minH: number) => {
    const hours = toHours(minutes);
    if (minutes > max * 60) {
      warnings.push({ type: `exceeds_max_${period}`, severity: 'warning', message: t(lang, `${hours} hours exceed the ${period}ly maximum of ${max}`, `${hours} Stunden überschreiten das Maximum von ${max}`), actualHours: hours, maxHours: max });
    } else if (minutes > target * 60) {
      warnings.push({ type: `above_target_${period}`, severity: 'info', message: t(lang, `${hours} hours are above the ${period}ly target of ${target}`, `${hours} Stunden liegen über dem Soll von ${target}`), actualHours: hours, targetHours: target });
    } else if (settings.roster.belowTargetOnAssign && minutes < target * 60) {
      warnings.push({ type: `below_target_${period}`, severity: 'info', message: t(lang, `${hours} hours are below the ${period}ly target of ${target}`, `${hours} Stunden liegen unter dem Soll von ${target}`), actualHours: hours, targetHours: target, minHours: minH });
    }
  };
  if (shift) {
    periodWarnings('week', weekMinutes, targets.targetHoursPerWeek, targets.maxHoursPerWeek, targets.minHoursPerWeek);
    periodWarnings('month', monthMinutes, targets.targetHoursPerMonth, targets.maxHoursPerMonth, targets.minHoursPerMonth);
  }

  // ---- pending absence, wishes ----
  const pending = await maybeOne(
    db,
    `SELECT id, type FROM time_offs WHERE employee_id = $1 AND status = 'pending' AND start_date <= $2 AND end_date >= $2 LIMIT 1`,
    [employee.id, date],
  );
  if (pending) {
    warnings.push({ type: 'pending_time_off_overlap', severity: 'warning', message: t(lang, 'A pending absence request covers this date', 'Ein offener Abwesenheitsantrag betrifft dieses Datum'), timeOffId: pending.id });
  }
  if (shift) {
    const wish = await maybeOne(
      db,
      `SELECT id, shift_id FROM employee_shift_wishes WHERE employee_id = $1 AND date = $2 AND kind = 'avoid'
          AND status IN ('pending','approved') AND (shift_id IS NULL OR shift_id = $3) LIMIT 1`,
      [employee.id, date, shift.id],
    );
    if (wish) {
      warnings.push({
        type: 'conflicts_with_wish',
        severity: 'info',
        message: wish.shift_id ? t(lang, 'The employee asked not to work this shift', 'Die Person möchte diese Schicht nicht arbeiten') : t(lang, 'The employee asked for this day off', 'Die Person wünscht sich diesen Tag frei'),
        wishId: wish.id,
      });
    }
  }

  // ---- short notice (published entries) ----
  let shortNotice = false;
  if (opts.mode === 'update' && opts.existing && opts.existing.status === 'published') {
    const startRef = new Date(Math.min(opts.existing.start.getTime(), proposed.start.getTime()));
    const hoursUntil = hoursBetween(now(), startRef);
    if (hoursUntil < settings.roster.changeNoticeHours) {
      shortNotice = true;
      warnings.push({
        type: 'short_notice_change',
        severity: 'warning',
        message: t(lang, `Change less than ${settings.roster.changeNoticeHours} hours before the start`, `Änderung weniger als ${settings.roster.changeNoticeHours} Stunden vor Beginn`),
        hoursBeforeStart: fmtH(hoursUntil),
      });
    }
  }

  // ---- minors (R18) ----
  const isMinor = !!employee.birth_date && ageOn(employee.birth_date, date) < 18;
  let minorViolations: MinorViolation[] = [];
  if (isMinor && shift) {
    const age = ageOn(employee.birth_date, date);
    const toMinor = (e: Entry): MinorShift => ({ date: e.date, start: e.start, end: e.end, startTime: e.startTime!, endTime: e.endTime!, paidMinutes: e.paidMinutes, breakMinutes: e.breakMinutes });
    const prev = shiftsOf(addDays(date, -1));
    const next = shiftsOf(addDays(date, 1));
    const school = (await creditsFor(db, employee.id, wStart, wEnd)).filter((c) => c.type === 'school').reduce((a, c) => a + c.creditMinutes, 0);
    const weekShiftDays = new Set(weekEntries.filter((e) => e.entryType === 'shift').map((e) => e.date)).size;
    minorViolations = evaluateMinorRules({
      age,
      settings: settings.legal.minors,
      dayShifts: dayShifts.map(toMinor),
      weekWorkMinutes: weekMinutes,
      weekSchoolCreditMinutes: school,
      weekShiftDays,
      prevDayLastEnd: prev.length ? new Date(Math.max(...prev.map((e) => e.end.getTime()))) : null,
      nextDayFirstStart: next.length ? new Date(Math.min(...next.map((e) => e.start.getTime()))) : null,
    });
    if (minorViolations.length > 0) {
      if (settings.legal.minors.enforcement === 'block') {
        throw new AppError('MINOR_PROTECTION_VIOLATION', { details: minorViolations });
      }
      warnings.push({
        type: 'minor_protection',
        severity: 'warning',
        message: t(lang, 'Youth employment protection rules are broken (JArbSchG)', 'Regeln des Jugendarbeitsschutzgesetzes werden verletzt'),
        details: minorViolations,
      });
    }
    const wd = isoWeekday(date);
    const holiday = holidayName(hotel.holidayRegion, date);
    if (wd >= 6 || holiday) {
      warnings.push({
        type: 'minor_weekend_holiday_check',
        severity: 'info',
        message: t(lang, 'Minor scheduled on a weekend or public holiday: check the legal exceptions and the compensation day', 'Jugendliche/r am Wochenende oder Feiertag eingeplant: Ausnahmen und Ersatzruhetag prüfen'),
      });
    }
  }
  if (
    minorViolations.length > 0 &&
    settings.legal.minors.requireOverrideReason &&
    !input.overrideReason?.trim() &&
    (opts.mode === 'create' || opts.mode === 'update')
  ) {
    throw new AppError('OVERRIDE_REASON_REQUIRED', { details: minorViolations });
  }

  return {
    hotel,
    employee,
    shift,
    proposed,
    warnings,
    minorViolations,
    isMinor,
    targets,
    paidMinutes: proposed.paidMinutes,
    weekMinutes,
    weekMinutesBefore,
    monthMinutes,
    restPeriodHours,
    shortNotice,
  };
}

export function evaluationResponse<E extends Record<string, unknown>>(ev: Evaluation, extra: E = {} as E) {
  const p = ev.proposed;
  return {
    ...extra,
    hotelId: p.hotelId,
    status: p.status,
    entryType: p.entryType,
    date: p.date,
    employee: { id: ev.employee.id, firstName: ev.employee.first_name, lastName: ev.employee.last_name },
    shift: ev.shift
      ? {
          id: ev.shift.id,
          name: ev.shift.name,
          departmentId: ev.shift.department_id,
          startTime: ev.shift.start_time,
          endTime: ev.shift.end_time,
          durationHours: toHours(p.durationMinutes),
          breakDurationMinutes: p.breakMinutes,
          paidHours: toHours(p.paidMinutes),
        }
      : null,
    offLabel: p.offLabel,
    paidHoursAssigned: toHours(p.paidMinutes),
    currentWeekHours: toHours(ev.weekMinutes),
    currentMonthHours: toHours(ev.monthMinutes),
    weeklyTarget: ev.targets.targetHoursPerWeek,
    monthlyTarget: ev.targets.targetHoursPerMonth,
    restPeriodHours: ev.restPeriodHours,
    warnings: ev.warnings,
    overrideReason: p.overrideReason,
    publishedAt: p.publishedAt,
  };
}

export async function findHotelEmployees(db: Db, hotelId: number, date: string) {
  return rows(
    db,
    `SELECT e.*, eh.is_home FROM employees e JOIN employee_hotels eh ON eh.employee_id = e.id
      WHERE eh.hotel_id = $1 AND (eh.unassigned_on IS NULL OR eh.unassigned_on >= $2::date) AND e.deleted_at IS NULL`,
    [hotelId, date],
  );
}
