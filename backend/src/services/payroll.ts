import iconv from 'iconv-lite';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import { Db, rows } from '../db/pool';
import { AppError } from '../errors/AppError';
import type { AuthContext } from '../types/context';
import { monthRange } from '../domain/dates';
import { DEFAULT_WAGE_TYPES } from '../domain/settings';
import { toCsv } from '../domain/csv';
import { supplementMinutes } from '../domain/supplements';
import { workedMinutes } from '../domain/anomalies';
import { countsAsWorked, shownWorkedMinutes } from '../domain/approval';
import { Hotel, loadHotel } from './access';
import { creditsFor } from './credits';
import { computeMonths } from './timeAccount';
import { isHoliday } from './holidays';
import { audit } from './audit';

export const PAYROLL_COLUMNS = [
  'employeeNumber', 'lastName', 'firstName', 'employmentType', 'payType', 'workedMinutes', 'plannedMinutes', 'creditedAnnualMinutes',
  'creditedSickMinutes', 'creditedSchoolMinutes', 'creditedPublicHolidayMinutes', 'absenceDaysAnnual', 'absenceDaysSick', 'absenceDaysUnpaid', 'nightMinutes',
  'saturdayMinutes', 'sundayMinutes', 'holidayMinutes', 'openOrReviewEntries', 'unapprovedEntries', 'timeAccountDeltaMinutes',
];

export interface PayrollRow {
  employeeId: number;
  employeeNumber: string | null;
  lastName: string;
  firstName: string;
  employmentType: string;
  payType: 'salary' | 'hourly';
  workedMinutes: number;
  plannedMinutes: number;
  creditedAnnualMinutes: number;
  creditedSickMinutes: number;
  creditedSchoolMinutes: number;
  creditedPublicHolidayMinutes: number;
  absenceDaysAnnual: number;
  absenceDaysSick: number;
  absenceDaysUnpaid: number;
  nightMinutes: number;
  saturdayMinutes: number;
  sundayMinutes: number;
  holidayMinutes: number;
  openOrReviewEntries: number;
  /** closed entries of unplanned work still waiting for a supervisor's decision: NOT included in the worked minutes (rejected ones are not counted at all) */
  unapprovedEntries: number;
  /** null for hourly workers (no time account) */
  timeAccountDeltaMinutes: number | null;
}

/**
 * R21 generic payroll data for one hotel and month. Supplement minutes (night, Saturday, Sunday, holiday) have the
 * unpaid break deducted automatically (proportionally, see domain/supplements). Worked, planned and supplement minutes are counted at this hotel;
 * credits and absence days follow the person and are reported by the employee's home hotel only (no double counting).
 */
export async function payrollRows(db: Db, hotel: Hotel, month: string): Promise<PayrollRow[]> {
  const { from, to } = monthRange(month);
  const emps = await rows(
    db,
    `SELECT DISTINCT e.*, (SELECT hotel_id FROM employee_hotels WHERE employee_id = e.id AND is_home) AS home_hotel_id FROM employees e
      WHERE e.id IN (
        SELECT te.employee_id FROM time_entries te WHERE te.hotel_id = $1 AND (te.clock_in_at AT TIME ZONE $4)::date BETWEEN $2 AND $3
        UNION SELECT s.employee_id FROM schedules s WHERE s.hotel_id = $1 AND s.date BETWEEN $2 AND $3)
      ORDER BY e.last_name, e.first_name, e.id`,
    [hotel.id, from, to, hotel.timezone],
  );
  const out: PayrollRow[] = [];
  const s = hotel.settings.payroll;
  for (const e of emps) {
    const entries = await rows(
      db,
      `SELECT * FROM time_entries WHERE employee_id = $1 AND hotel_id = $2 AND (clock_in_at AT TIME ZONE $5)::date BETWEEN $3 AND $4 ORDER BY clock_in_at`,
      [e.id, hotel.id, from, to, hotel.timezone],
    );
    let worked = 0;
    let open = 0;
    let unapproved = 0;
    const sup = { nightMinutes: 0, saturdayMinutes: 0, sundayMinutes: 0, holidayMinutes: 0 };
    for (const te of entries) {
      if (te.status !== 'closed') {
        open++;
        continue;
      }
      if (!countsAsWorked(te)) {
        // SPEC 1.12: only approved hours are paid. Pending entries are reported (a decision is still due);
        // rejected ones are final: no hours, no open item, no warning.
        if (te.approval_status === 'pending') unapproved++;
        continue;
      }
      worked += workedMinutes(new Date(te.clock_in_at), new Date(te.clock_out_at), te.break_minutes) ?? 0;
      const m = supplementMinutes(new Date(te.clock_in_at), new Date(te.clock_out_at), hotel.timezone, s.nightFrom, s.nightTo, (d) => isHoliday(hotel.holidayRegion, d), te.break_minutes);
      sup.nightMinutes += m.nightMinutes;
      sup.saturdayMinutes += m.saturdayMinutes;
      sup.sundayMinutes += m.sundayMinutes;
      sup.holidayMinutes += m.holidayMinutes;
    }
    const planned = (
      await rows(
        db,
        `SELECT COALESCE(SUM(sh.duration_minutes - sh.break_duration_minutes), 0)::int AS n FROM schedules sc JOIN shifts sh ON sh.id = sc.shift_id
          WHERE sc.employee_id = $1 AND sc.hotel_id = $2 AND sc.status = 'published' AND sc.date BETWEEN $3 AND $4`,
        [e.id, hotel.id, from, to],
      )
    )[0].n;
    const isHome = e.home_hotel_id === hotel.id;
    const credits = isHome ? await creditsFor(db, e.id, from, to) : [];
    const sumC = (type: string) => Math.round(credits.filter((c) => c.type === type).reduce((a, c) => a + c.creditMinutes, 0));
    const days = isHome
      ? await rows(
          db,
          `SELECT t.type, SUM(d.day_fraction)::float AS n FROM time_off_dates d JOIN time_offs t ON t.id = d.time_off_id
            WHERE d.employee_id = $1 AND t.status = 'approved' AND d.date BETWEEN $2 AND $3 GROUP BY t.type`,
          [e.id, from, to],
        )
      : [];
    const dayN = (type: string) => days.find((d) => d.type === type)?.n ?? 0;
    const delta = e.pay_type === 'hourly' ? null : isHome ? Math.round((await computeMonths(db, e.id, month, month))[0].deltaMinutes) : 0;
    out.push({
      employeeId: e.id,
      employeeNumber: e.employee_number,
      lastName: e.last_name,
      firstName: e.first_name,
      employmentType: e.employment_type,
      payType: e.pay_type,
      workedMinutes: worked,
      plannedMinutes: planned,
      creditedAnnualMinutes: sumC('annual_leave'),
      creditedSickMinutes: sumC('sick_leave'),
      creditedSchoolMinutes: sumC('school'),
      creditedPublicHolidayMinutes: sumC('public_holiday'),
      absenceDaysAnnual: dayN('annual_leave'),
      absenceDaysSick: dayN('sick_leave'),
      absenceDaysUnpaid: dayN('unpaid_leave'),
      nightMinutes: Math.round(sup.nightMinutes),
      saturdayMinutes: Math.round(sup.saturdayMinutes),
      sundayMinutes: Math.round(sup.sundayMinutes),
      holidayMinutes: Math.round(sup.holidayMinutes),
      openOrReviewEntries: open,
      unapprovedEntries: unapproved,
      timeAccountDeltaMinutes: delta,
    });
  }
  return out;
}

export async function payrollExport(db: Db, ctx: AuthContext, hotelId: number, month: string, format: 'csv' | 'json' | 'datev' | 'xlsx') {
  if (!ctx.hotelIds.includes(hotelId)) throw new AppError('RESOURCE_NOT_FOUND');
  const hotel = await loadHotel(db, hotelId);
  const data = await payrollRows(db, hotel, month);
  const { to } = monthRange(month);
  const warnings: string[] = !hotel.attendanceLockedUntil || hotel.attendanceLockedUntil < to ? ['period_not_locked'] : [];
  if (data.some((r) => r.unapprovedEntries > 0)) warnings.push('entries_pending_approval');
  await audit(db, ctx, { action: 'payroll.export', entityType: 'hotel', entityId: hotelId, hotelId, meta: { month, format, employees: data.length } });
  if (format === 'json') return { kind: 'json' as const, body: { hotelId, month, warnings, data } };
  if (format === 'csv') return { kind: 'csv' as const, body: toCsv(PAYROLL_COLUMNS, data as any), warnings };
  if (format === 'xlsx') return { kind: 'xlsx' as const, body: await buildXlsx(data), warnings };
  return { kind: 'datev' as const, body: buildDatev(hotel, month, data), warnings };
}

const EMPLOYMENT_LABEL: Record<string, string> = {
  full_time: 'Vollzeit', part_time: 'Teilzeit', mini_job: 'Minijob', working_student: 'Werkstudent', apprentice: 'Auszubildende', intern: 'Praktikum', other: 'Sonstige',
};
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

/** Plain spreadsheet for the payroll clerk: readable headers, hours as decimal numbers (not minutes), a total row, no DATEV knowledge needed. */
const XLSX_COLUMNS: { header: string; width: number; value: (r: PayrollRow) => string | number | null; sum?: boolean; format?: string }[] = [
  { header: 'Personalnr.', width: 12, value: (r) => r.employeeNumber },
  { header: 'Nachname', width: 18, value: (r) => r.lastName },
  { header: 'Vorname', width: 16, value: (r) => r.firstName },
  { header: 'Beschäftigung', width: 16, value: (r) => EMPLOYMENT_LABEL[r.employmentType] ?? r.employmentType },
  { header: 'Vergütung', width: 12, value: (r) => (r.payType === 'salary' ? 'Gehalt' : 'Stundenlohn') },
  { header: 'Arbeitszeit (Std.)', width: 14, value: (r) => hours(r.workedMinutes), sum: true, format: '0.00' },
  { header: 'Soll laut Plan (Std.)', width: 14, value: (r) => hours(r.plannedMinutes), sum: true, format: '0.00' },
  { header: 'Urlaub (Std.)', width: 12, value: (r) => hours(r.creditedAnnualMinutes), sum: true, format: '0.00' },
  { header: 'Krank (Std.)', width: 12, value: (r) => hours(r.creditedSickMinutes), sum: true, format: '0.00' },
  { header: 'Berufsschule (Std.)', width: 14, value: (r) => hours(r.creditedSchoolMinutes), sum: true, format: '0.00' },
  { header: 'Feiertag Gutschrift (Std.)', width: 16, value: (r) => hours(r.creditedPublicHolidayMinutes), sum: true, format: '0.00' },
  { header: 'Urlaubstage', width: 12, value: (r) => r.absenceDaysAnnual, sum: true, format: '0.0' },
  { header: 'Krankheitstage', width: 12, value: (r) => r.absenceDaysSick, sum: true, format: '0.0' },
  { header: 'Unbezahlt (Tage)', width: 12, value: (r) => r.absenceDaysUnpaid, sum: true, format: '0.0' },
  { header: 'Nacht (Std.)', width: 12, value: (r) => hours(r.nightMinutes), sum: true, format: '0.00' },
  { header: 'Samstag (Std.)', width: 12, value: (r) => hours(r.saturdayMinutes), sum: true, format: '0.00' },
  { header: 'Sonntag (Std.)', width: 12, value: (r) => hours(r.sundayMinutes), sum: true, format: '0.00' },
  { header: 'Feiertag Zuschlag (Std.)', width: 16, value: (r) => hours(r.holidayMinutes), sum: true, format: '0.00' },
  { header: 'Offene Einträge', width: 12, value: (r) => r.openOrReviewEntries, sum: true },
  { header: 'Nicht genehmigt', width: 12, value: (r) => r.unapprovedEntries, sum: true },
  { header: 'Zeitkonto-Saldo (Std.)', width: 16, value: (r) => r.timeAccountDeltaMinutes === null ? null : hours(r.timeAccountDeltaMinutes), sum: true, format: '0.00' },
];

async function buildXlsx(data: PayrollRow[]): Promise<Buffer> {
  const bold = { fontWeight: 'bold' as const };
  const sheet: SheetData = [
    XLSX_COLUMNS.map((c) => ({ value: c.header, ...bold, wrap: true })),
    ...data.map((r) => XLSX_COLUMNS.map((c) => {
      const v = c.value(r);
      return typeof v === 'number' ? { value: v, type: Number, format: c.format } : { value: v ?? '' };
    })),
    XLSX_COLUMNS.map((c, i) => {
      if (i === 0) return { value: 'Summe', ...bold };
      if (!c.sum) return null;
      const total = data.reduce((acc, r) => acc + Number(c.value(r)), 0);
      return { value: Math.round(total * 100) / 100, type: Number, format: c.format, ...bold };
    }),
  ];
  return writeXlsxFile(sheet, { sheet: 'Lohnexport', columns: XLSX_COLUMNS.map((c) => ({ width: c.width })), stickyRowsCount: 1 }).toBuffer();
}

const WAGE_KEYS: { key: keyof Hotel['settings']['payroll']['datev']['wageTypes']; column: keyof PayrollRow; note: string }[] = [
  { key: 'worked', column: 'workedMinutes', note: 'Stunden' },
  { key: 'annualLeave', column: 'creditedAnnualMinutes', note: 'Urlaub' },
  { key: 'sick', column: 'creditedSickMinutes', note: 'Krank' },
  { key: 'school', column: 'creditedSchoolMinutes', note: 'Berufsschule' },
  { key: 'publicHoliday', column: 'creditedPublicHolidayMinutes', note: 'Feiertagslohn' },
  { key: 'night', column: 'nightMinutes', note: 'Nacht' },
  { key: 'saturday', column: 'saturdayMinutes', note: 'Samstag' },
  { key: 'sunday', column: 'sundayMinutes', note: 'Sonntag' },
  { key: 'holiday', column: 'holidayMinutes', note: 'Feiertag' },
];

const fill = (tpl: string, values: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
const comma = (n: number, digits: number) => n.toFixed(digits).replace('.', ',');

/**
 * DATEV Lohn (LODAS ASCII import), template-driven (R21): nothing about the layout is hard-coded. Hours are
 * rounded once per month and wage type. Refuses to run while the mapping is incomplete.
 */
export function buildDatev(hotel: Hotel, month: string, data: PayrollRow[]): Buffer {
  const d = hotel.settings.payroll.datev;
  const missing: { field: string; issue: string }[] = [];
  if (!d.consultantNumber) missing.push({ field: 'payroll.datev.consultantNumber', issue: 'missing' });
  if (!d.clientNumber) missing.push({ field: 'payroll.datev.clientNumber', issue: 'missing' });
  if (!d.headerTemplate) missing.push({ field: 'payroll.datev.headerTemplate', issue: 'missing' });
  if (!d.recordDescriptionTemplate) missing.push({ field: 'payroll.datev.recordDescriptionTemplate', issue: 'missing' });
  if (!d.lineTemplate) missing.push({ field: 'payroll.datev.lineTemplate', issue: 'missing' });
  if (missing.length > 0) throw new AppError('PAYROLL_MAPPING_INCOMPLETE', { details: missing });
  const noNumber = data.filter((r) => !r.employeeNumber);
  if (noNumber.length > 0) {
    // R21 / test 116: a business-rule failure of the export, answered with 422 (not a malformed request)
    throw new AppError('VALIDATION_ERROR', { status: 422, details: noNumber.map((r) => ({ field: 'employeeNumber', issue: 'personnel number missing', employeeId: r.employeeId })) });
  }
  const { to } = monthRange(month);
  const date = `${to.slice(8, 10)}.${to.slice(5, 7)}.${to.slice(0, 4)}`;
  const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n').replace(/(\r\n)+$/, '');
  const lines: string[] = [
    crlf(fill(d.headerTemplate, { consultantNumber: d.consultantNumber!, clientNumber: d.clientNumber!, month: `${month.slice(5, 7)}/${month.slice(0, 4)}` })),
    crlf(d.recordDescriptionTemplate),
  ];
  const sorted = [...data].sort((a, b) => (a.employeeNumber! < b.employeeNumber! ? -1 : a.employeeNumber! > b.employeeNumber! ? 1 : 0));
  for (const r of sorted) {
    for (const w of WAGE_KEYS) {
      const minutes = r[w.column] as number;
      if (minutes > 0) {
        lines.push(fill(d.lineTemplate, { pnr: r.employeeNumber!, date, value: comma(Math.round(minutes / 60 * 100) / 100, 2), key: '1', wageType: d.wageTypes[w.key] || DEFAULT_WAGE_TYPES[w.key], note: w.note }));
      }
    }
    if (r.absenceDaysAnnual > 0) lines.push(fill(d.lineTemplate, { pnr: r.employeeNumber!, date, value: comma(r.absenceDaysAnnual, 1), key: '71', wageType: '', note: 'Urlaub Tage' }));
    if (r.absenceDaysSick > 0) lines.push(fill(d.lineTemplate, { pnr: r.employeeNumber!, date, value: comma(r.absenceDaysSick, 1), key: '72', wageType: '', note: 'Krank Tage' }));
  }
  return iconv.encode(lines.join('\r\n') + '\r\n', d.encoding || 'windows-1252');
}

export async function attendanceExport(db: Db, ctx: AuthContext, hotelId: number, from: string, to: string) {
  const hotel = await loadHotel(db, hotelId);
  const list = await rows(
    db,
    `SELECT te.*, e.employee_number, sh.name AS shift_name FROM time_entries te JOIN employees e ON e.id = te.employee_id
       LEFT JOIN schedules s ON s.id = te.schedule_id LEFT JOIN shifts sh ON sh.id = s.shift_id
      WHERE te.hotel_id = $1 AND (te.clock_in_at AT TIME ZONE $4)::date BETWEEN $2 AND $3 ORDER BY te.clock_in_at`,
    [hotelId, from, to, hotel.timezone],
  );
  const data = list.map((te) => ({
    date: new Intl.DateTimeFormat('en-CA', { timeZone: hotel.timezone }).format(new Date(te.clock_in_at)),
    employeeNumber: te.employee_number,
    shift: te.shift_name,
    clockIn: new Date(te.clock_in_at).toISOString(),
    clockOut: te.clock_out_at ? new Date(te.clock_out_at).toISOString() : '',
    breakMinutes: te.break_minutes,
    workedMinutes: shownWorkedMinutes(te, workedMinutes(new Date(te.clock_in_at), te.clock_out_at ? new Date(te.clock_out_at) : null, te.break_minutes)) ?? '',
    anomalies: (te.anomalies ?? []).map((a: any) => a.type).join('|'),
    status: te.status,
    approvalStatus: te.approval_status,
  }));
  await audit(db, ctx, { action: 'attendance.export', entityType: 'hotel', entityId: hotelId, hotelId, meta: { from, to, rows: data.length } });
  return toCsv(['date', 'employeeNumber', 'shift', 'clockIn', 'clockOut', 'breakMinutes', 'workedMinutes', 'anomalies', 'status', 'approvalStatus'], data);
}
