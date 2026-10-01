import { Db, rows } from '../../db/pool';
import { shiftInstants, dayStart } from '../../domain/instants';
import { durationMinutes } from '../../domain/hours';

export interface Entry {
  id: number;
  hotelId: number;
  hotelName: string;
  timezone: string;
  employeeId: number;
  entryType: 'shift' | 'off';
  shiftId: number | null;
  shiftName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  startTime: string | null;
  endTime: string | null;
  breakMinutes: number;
  durationMinutes: number;
  paidMinutes: number;
  date: string;
  status: 'draft' | 'published';
  offLabel: string | null;
  warnings: any[];
  overrideReason: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  start: Date;
  end: Date;
}

export const ENTRY_SELECT = `
  SELECT s.id, s.hotel_id, h.name AS hotel_name, h.timezone, s.employee_id, s.entry_type, s.shift_id, sh.name AS shift_name,
         sh.department_id, d.name AS department_name, sh.start_time, sh.end_time, sh.break_duration_minutes, s.date, s.status,
         s.off_label, s.warnings, s.override_reason, s.published_at, s.updated_at
    FROM schedules s
    JOIN hotels h ON h.id = s.hotel_id
    LEFT JOIN shifts sh ON sh.id = s.shift_id
    LEFT JOIN departments d ON d.id = sh.department_id`;

export function mapEntry(r: any): Entry {
  const isShift = r.entry_type === 'shift' && r.start_time;
  const duration = isShift ? durationMinutes(r.start_time, r.end_time) : 0;
  const brk = isShift ? r.break_duration_minutes : 0;
  const inst = isShift
    ? shiftInstants(r.date, r.start_time, r.end_time, r.timezone)
    : { start: dayStart(r.date, r.timezone), end: dayStart(r.date, r.timezone) };
  return {
    id: r.id,
    hotelId: r.hotel_id,
    hotelName: r.hotel_name,
    timezone: r.timezone,
    employeeId: r.employee_id,
    entryType: r.entry_type,
    shiftId: r.shift_id,
    shiftName: r.shift_name ?? null,
    departmentId: r.department_id ?? null,
    departmentName: r.department_name ?? null,
    startTime: r.start_time ?? null,
    endTime: r.end_time ?? null,
    breakMinutes: brk,
    durationMinutes: duration,
    paidMinutes: duration - brk,
    date: r.date,
    status: r.status,
    offLabel: r.off_label,
    warnings: r.warnings ?? [],
    overrideReason: r.override_reason,
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
    start: inst.start,
    end: inst.end,
  };
}

/** All entries of an employee (every hotel) in a date range. */
export async function loadEmployeeEntries(db: Db, employeeId: number, from: string, to: string, opts: { publishedOnly?: boolean } = {}): Promise<Entry[]> {
  const list = await rows(
    db,
    `${ENTRY_SELECT} WHERE s.employee_id = $1 AND s.date BETWEEN $2 AND $3 ${opts.publishedOnly ? "AND s.status = 'published'" : ''}
     ORDER BY s.date, sh.start_time NULLS FIRST, s.id`,
    [employeeId, from, to],
  );
  return list.map(mapEntry);
}

export async function loadEntryById(db: Db, id: number): Promise<Entry | null> {
  const list = await rows(db, `${ENTRY_SELECT} WHERE s.id = $1`, [id]);
  return list[0] ? mapEntry(list[0]) : null;
}
