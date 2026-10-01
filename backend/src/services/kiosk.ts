import { randomInt } from 'node:crypto';
import { Db, getPool, maybeOne, rows } from '../db/pool';
import { withTransaction, lockEmployees } from '../db/tx';
import { mapDbError } from '../db/errorMap';
import { AppError } from '../errors/AppError';
import type { AuthContext, DeviceContext } from '../types/context';
import { addDays, ageOn, localDate, localTime } from '../domain/dates';
import { shiftInstants } from '../domain/instants';
import { displayName } from '../domain/names';
import { autoBreakMinutes, Anomaly, clockInAnomalies, clockOutAnomalies } from '../domain/anomalies';
import { requiredBreak } from '../domain/hours';
import { gapsBetweenParts } from '../domain/restPeriod';
import { now } from '../clock';
import { audit, sha256 } from './audit';
import { Hotel, loadHotel, resolveHotelId } from './access';
import { burnTime, randomToken, verifySecret } from './tokens';
import { managerIdsOfHotel, notify } from './notifications';

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_TTL_MS = 10 * 60_000;
const PUNCH_TTL_MS = 60_000;

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function createPairingCode(db: Db, ctx: AuthContext, input: { hotelId?: number; deviceName: string }) {
  const hotelId = resolveHotelId(ctx, input.hotelId);
  let raw = '';
  for (let i = 0; i < 8; i++) raw += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  const pairingCode = `${raw.slice(0, 3)}-${raw.slice(3, 6)}-${raw.slice(6)}`;
  const expiresAt = new Date(now().getTime() + PAIRING_TTL_MS);
  await db.query(
    'INSERT INTO kiosk_pairing_codes (hotel_id, device_name, code_hash, expires_at, created_by_id) VALUES ($1,$2,$3,$4,$5)',
    [hotelId, input.deviceName, sha256(normalizeCode(pairingCode)), expiresAt, ctx.userId],
  );
  await audit(db, ctx, { action: 'kiosk.pairing_code', entityType: 'hotel', entityId: hotelId, hotelId });
  return { pairingCode, expiresAt, deviceName: input.deviceName, hotelId };
}

export async function pairDevice(pairingCode: string, requestId: string) {
  return withTransaction(async (db) => {
    const t = now();
    const code = await maybeOne(
      db,
      `UPDATE kiosk_pairing_codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING *`,
      [sha256(normalizeCode(pairingCode)), t],
    );
    if (!code) throw new AppError('PAIRING_CODE_INVALID');
    const deviceToken = randomToken(32);
    const d = await maybeOne(
      db,
      'INSERT INTO kiosk_devices (hotel_id, name, token_hash, created_by_id, last_seen_at) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [code.hotel_id, code.device_name, sha256(deviceToken), code.created_by_id, t],
    );
    const hotel = await loadHotel(db, code.hotel_id);
    await audit(db, { userId: code.created_by_id, companyId: hotel.companyId, requestId }, { action: 'kiosk.pair', entityType: 'kiosk_device', entityId: d.id, hotelId: hotel.id });
    return { deviceToken, device: { id: d.id, name: d.name }, hotel: { id: hotel.id, name: hotel.name, timezone: hotel.timezone } };
  });
}

function ipAllowed(ip: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, '');
  return allowed.some((a) => a === ip || a === clean);
}

/** X-Device-Token check (R13.1): missing, unknown or revoked → 401 DEVICE_UNAUTHORIZED; IP allow-list per hotel. */
export async function authenticateDevice(db: Db, token: string | undefined, ip: string | undefined): Promise<DeviceContext> {
  if (!token) throw new AppError('DEVICE_UNAUTHORIZED');
  const d = await maybeOne(db, `SELECT * FROM kiosk_devices WHERE token_hash = $1`, [sha256(token)]);
  if (!d || d.status !== 'active') throw new AppError('DEVICE_UNAUTHORIZED');
  const hotel = await loadHotel(db, d.hotel_id);
  if (!ipAllowed(ip, hotel.settings.attendance.kioskAllowedIps)) throw new AppError('DEVICE_UNAUTHORIZED', { details: [{ issue: 'IP address not allowed' }] });
  await db.query('UPDATE kiosk_devices SET last_seen_at = $2 WHERE id = $1', [d.id, now()]);
  return { deviceId: d.id, hotelId: d.hotel_id, name: d.name };
}

export async function listDevices(db: Db, ctx: AuthContext, hotelId?: number) {
  const h = resolveHotelId(ctx, hotelId);
  const list = await rows(db, 'SELECT * FROM kiosk_devices WHERE hotel_id = $1 ORDER BY id', [h]);
  return { data: list.map((d) => ({ id: d.id, hotelId: d.hotel_id, name: d.name, status: d.status, lastSeenAt: d.last_seen_at, createdAt: d.created_at, revokedAt: d.revoked_at })) };
}

export async function revokeDevice(db: Db, ctx: AuthContext, id: number) {
  const d = await maybeOne(db, 'SELECT * FROM kiosk_devices WHERE id = $1', [id]);
  if (!d || !ctx.hotelIds.includes(d.hotel_id)) throw new AppError('RESOURCE_NOT_FOUND');
  await db.query(`UPDATE kiosk_devices SET status = 'revoked', revoked_at = $2 WHERE id = $1`, [id, now()]);
  await audit(db, ctx, { action: 'kiosk.revoke', entityType: 'kiosk_device', entityId: id, hotelId: d.hotel_id });
}

// ------------------------------------------------------------------
interface TodayShift {
  scheduleId: number;
  hotelId: number;
  hotelName: string;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  start: Date;
  end: Date;
}

/** Published shifts of an employee on the hotel-local day before and on `today` (night shifts still running). */
async function publishedShifts(db: Db, employeeId: number, from: string, to: string, hotelId?: number): Promise<TodayShift[]> {
  const list = await rows(
    db,
    `SELECT s.id, s.hotel_id, h.name AS hotel_name, h.timezone, s.date, sh.name, sh.start_time, sh.end_time, sh.break_duration_minutes
       FROM schedules s JOIN shifts sh ON sh.id = s.shift_id JOIN hotels h ON h.id = s.hotel_id
      WHERE s.employee_id = $1 AND s.status = 'published' AND s.entry_type = 'shift' AND s.date BETWEEN $2 AND $3
        AND ($4::bigint IS NULL OR s.hotel_id = $4)
      ORDER BY s.date, sh.start_time`,
    [employeeId, from, to, hotelId ?? null],
  );
  return list.map((r) => {
    const inst = shiftInstants(r.date, r.start_time, r.end_time, r.timezone);
    return { scheduleId: r.id, hotelId: r.hotel_id, hotelName: r.hotel_name, name: r.name, date: r.date, startTime: r.start_time, endTime: r.end_time, breakMinutes: r.break_duration_minutes, ...inst };
  });
}

async function openEntryOf(db: Db, employeeId: number) {
  return maybeOne(db, `SELECT * FROM time_entries WHERE employee_id = $1 AND status IN ('open','needs_review') ORDER BY clock_in_at DESC LIMIT 1`, [employeeId]);
}

async function statusOf(db: Db, employeeId: number): Promise<{ status: 'not_in' | 'in' | 'on_break'; open: any }> {
  const open = await openEntryOf(db, employeeId);
  if (!open || open.status !== 'open') return { status: 'not_in', open };
  const brk = await maybeOne(db, 'SELECT 1 FROM time_entry_breaks WHERE time_entry_id = $1 AND break_end_at IS NULL', [open.id]);
  return { status: brk ? 'on_break' : 'in', open };
}

function allowedActions(status: 'not_in' | 'in' | 'on_break', open: any, breakMode: string): string[] {
  if (open && open.status === 'needs_review') return [];
  if (status === 'not_in') return ['clock_in'];
  if (status === 'on_break') return ['break_end', 'clock_out'];
  return breakMode === 'recorded' ? ['break_start', 'clock_out'] : ['clock_out'];
}

const shiftView = (s: TodayShift) => ({ name: s.name, startTime: s.startTime, endTime: s.endTime });

/** K2: data minimisation – displayName, status and today's shifts only. */
export async function kioskRoster(db: Db, device: DeviceContext, search?: string) {
  const hotel = await loadHotel(db, device.hotelId);
  const t = now();
  const today = localDate(t, hotel.timezone);
  const candidates = new Map<number, any>();
  const shiftRows = await rows(
    db,
    `SELECT s.employee_id, e.first_name, e.last_name FROM schedules s JOIN employees e ON e.id = s.employee_id
      WHERE s.hotel_id = $1 AND s.status = 'published' AND s.entry_type = 'shift' AND s.date BETWEEN $2 AND $3
        AND e.deleted_at IS NULL AND e.status <> 'terminated'`,
    [hotel.id, addDays(today, -1), today],
  );
  for (const r of shiftRows) candidates.set(r.employee_id, r);
  const openRows = await rows(
    db,
    `SELECT te.employee_id, e.first_name, e.last_name FROM time_entries te JOIN employees e ON e.id = te.employee_id
      WHERE te.hotel_id = $1 AND te.status IN ('open','needs_review')`,
    [hotel.id],
  );
  const withOpen = new Set(openRows.map((r) => r.employee_id));
  for (const r of openRows) candidates.set(r.employee_id, r);
  const searchIds = new Set<number>();
  if (search && search.trim().length > 0) {
    const found = await rows(
      db,
      `SELECT e.id AS employee_id, e.first_name, e.last_name FROM employees e JOIN employee_hotels eh ON eh.employee_id = e.id
        WHERE eh.hotel_id = $1 AND (eh.unassigned_on IS NULL OR eh.unassigned_on >= $2::date) AND e.deleted_at IS NULL AND e.status <> 'terminated'
          AND (e.first_name || ' ' || e.last_name) ILIKE $3 ORDER BY e.first_name LIMIT 20`,
      [hotel.id, today, `%${search.trim()}%`],
    );
    for (const r of found) {
      candidates.set(r.employee_id, r);
      searchIds.add(r.employee_id);
    }
  }
  const employees = [];
  for (const [employeeId, r] of candidates) {
    const shifts = (await publishedShifts(db, employeeId, addDays(today, -1), today, hotel.id)).filter((s) => s.date === today || s.end > t);
    const inWindow = shifts.some((s) => t.getTime() >= s.start.getTime() - 2 * 3_600_000 && t <= s.end);
    if (!inWindow && !withOpen.has(employeeId) && !searchIds.has(employeeId)) continue;
    const st = await statusOf(db, employeeId);
    employees.push({ id: employeeId, displayName: displayName(r.first_name, r.last_name), status: st.status, todayShifts: shifts.map(shiftView) });
  }
  employees.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { serverTime: t.toISOString(), employees };
}

async function genericInvalidPin(hotel: Hotel) {
  return new AppError('INVALID_PIN', { extra: { attemptsLeft: Math.max(0, hotel.settings.attendance.pinMaxAttempts - 1) } });
}

/** K3: PIN check; generic INVALID_PIN for employees not assigned to this hotel (no enumeration). */
export async function verifyPin(device: DeviceContext, employeeId: number, pin: string, requestId: string) {
  return withTransaction(async (db) => {
    const hotel = await loadHotel(db, device.hotelId);
    const s = hotel.settings.attendance;
    const t = now();
    const today = localDate(t, hotel.timezone);
    const emp = await maybeOne(
      db,
      `SELECT e.* FROM employees e JOIN employee_hotels eh ON eh.employee_id = e.id AND eh.hotel_id = $2
        WHERE e.id = $1 AND e.deleted_at IS NULL AND e.status <> 'terminated' AND (eh.unassigned_on IS NULL OR eh.unassigned_on >= $3::date)`,
      [employeeId, hotel.id, today],
    );
    const pinRow = emp ? await maybeOne(db, 'SELECT * FROM employee_pins WHERE employee_id = $1 FOR UPDATE', [employeeId]) : null;
    if (!emp || !pinRow) {
      await burnTime(pin); // same duration as a real check: no timing difference between "no PIN / not assigned" and "wrong PIN"
      throw await genericInvalidPin(hotel);
    }
    const actx = { userId: null as any, companyId: hotel.companyId, requestId };
    if (pinRow.locked_until && new Date(pinRow.locked_until) > t) {
      throw new AppError('PIN_LOCKED', { extra: { lockedUntil: new Date(pinRow.locked_until).toISOString() } });
    }
    const ok = await verifySecret(pin, pinRow.pin_hash);
    if (!ok) {
      const failed = pinRow.failed_count + 1;
      if (failed >= s.pinMaxAttempts) {
        const lockedUntil = new Date(t.getTime() + s.pinLockMinutes * 60_000);
        await db.query('UPDATE employee_pins SET failed_count = 0, locked_until = $2 WHERE employee_id = $1', [employeeId, lockedUntil]);
        await audit(db, actx, { action: 'pin.locked', entityType: 'employee', entityId: employeeId, hotelId: hotel.id, meta: { deviceId: device.deviceId } });
      } else {
        await db.query('UPDATE employee_pins SET failed_count = $2 WHERE employee_id = $1', [employeeId, failed]);
        await audit(db, actx, { action: 'pin.failed', entityType: 'employee', entityId: employeeId, hotelId: hotel.id, meta: { deviceId: device.deviceId } });
      }
      // the failed-attempt counter must survive the error response
      await db.query('COMMIT');
      await db.query('BEGIN');
      throw new AppError('INVALID_PIN', { extra: { attemptsLeft: Math.max(0, s.pinMaxAttempts - failed) } });
    }
    await db.query('UPDATE employee_pins SET failed_count = 0, locked_until = NULL WHERE employee_id = $1', [employeeId]);
    const punchToken = randomToken(24);
    await db.query(
      'INSERT INTO kiosk_punch_tokens (token_hash, device_id, employee_id, expires_at) VALUES ($1,$2,$3,$4)',
      [sha256(punchToken), device.deviceId, employeeId, new Date(t.getTime() + PUNCH_TTL_MS)],
    );
    const st = await statusOf(db, employeeId);
    const shifts = (await publishedShifts(db, employeeId, addDays(today, -1), today, hotel.id)).filter((x) => x.date === today || x.end > t);
    return {
      punchToken,
      displayName: displayName(emp.first_name, emp.last_name),
      status: st.status,
      allowedActions: allowedActions(st.status, st.open, s.breakMode),
      todayShifts: shifts.map(shiftView),
    };
  });
}

async function dayWorkedMinutes(db: Db, employeeId: number, date: string, tz: string, excludeId?: number) {
  const list = await rows(
    db,
    `SELECT te.clock_in_at, te.clock_out_at, te.break_minutes FROM time_entries te JOIN hotels h ON h.id = te.hotel_id
      WHERE te.employee_id = $1 AND te.status = 'closed' AND (te.clock_in_at AT TIME ZONE h.timezone)::date = $2 AND ($3::bigint IS NULL OR te.id <> $3)
      ORDER BY te.clock_in_at`,
    [employeeId, date, excludeId ?? null],
  );
  void tz;
  return list;
}

const sumWorked = (list: any[]) =>
  list.reduce((a, e) => a + Math.max(0, Math.floor((new Date(e.clock_out_at).getTime() - new Date(e.clock_in_at).getTime()) / 60_000) - e.break_minutes), 0);

/** K4: one action with server time only. The tablet never sends a time. */
export async function punch(device: DeviceContext, punchToken: string, action: 'clock_in' | 'clock_out' | 'break_start' | 'break_end', requestId: string) {
  // consume the token first (single use) in its own statement so a failed action still burns it
  const t = now();
  const db0 = getPool();
  const tok = await maybeOne(
    db0,
    `UPDATE kiosk_punch_tokens SET used_at = $3 WHERE token_hash = $1 AND device_id = $2 AND used_at IS NULL AND expires_at > $3 RETURNING employee_id`,
    [sha256(punchToken), device.deviceId, t],
  );
  if (!tok) throw new AppError('PUNCH_TOKEN_INVALID');
  const employeeId: number = tok.employee_id;
  return withTransaction(async (db) => {
    await lockEmployees(db, [employeeId]);
    const hotel = await loadHotel(db, device.hotelId);
    const s = hotel.settings;
    const emp = await maybeOne(db, 'SELECT * FROM employees WHERE id = $1', [employeeId]);
    const today = localDate(t, hotel.timezone);
    const open = await openEntryOf(db, employeeId);
    const actx = { userId: null as any, companyId: hotel.companyId, requestId };
    let entryId: number;
    let anomalies: Anomaly[] = [];
    if (action === 'clock_in') {
      if (open) throw new AppError(open.status === 'needs_review' ? 'ENTRY_NEEDS_REVIEW' : 'INVALID_PUNCH_STATE');
      const shifts = await publishedShifts(db, employeeId, addDays(today, -1), today);
      const linked = await rows(db, 'SELECT schedule_id FROM time_entries WHERE schedule_id = ANY($1::bigint[])', [shifts.map((x) => x.scheduleId)]);
      const linkedIds = new Set(linked.map((l) => l.schedule_id));
      const here = shifts
        .filter((x) => x.hotelId === hotel.id && !linkedIds.has(x.scheduleId))
        .filter((x) => t.getTime() >= x.start.getTime() - Math.max(2 * 60, s.attendance.earlyClockInMinutes) * 60_000 && t <= x.end)
        .sort((a, b) => Math.abs(a.start.getTime() - t.getTime()) - Math.abs(b.start.getTime() - t.getTime()));
      const link = here[0] ?? null;
      anomalies = clockInAnomalies(t, link, s.attendance);
      if (!link) {
        const elsewhere = shifts.find((x) => x.hotelId !== hotel.id && (x.date === today || x.end > t));
        if (elsewhere) anomalies.push({ type: 'scheduled_elsewhere', hotelName: elsewhere.hotelName, shiftName: elsewhere.name });
      }
      const absence = await maybeOne(db, `SELECT id FROM time_offs WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2 AND end_date >= $2 LIMIT 1`, [employeeId, today]);
      if (absence) anomalies.push({ type: 'during_time_off' });
      const minor = emp.birth_date && ageOn(emp.birth_date, today) < 18;
      if (minor) {
        const age = ageOn(emp.birth_date, today);
        const latest = age >= 16 ? s.legal.minors.latestEndHospitality16Plus : s.legal.minors.latestEnd;
        const lt = localTime(t, hotel.timezone);
        if (lt < s.legal.minors.earliestStart || lt >= latest) anomalies.push({ type: 'minor_outside_hours', localTime: lt });
      }
      try {
        const r = await maybeOne(
          db,
          `INSERT INTO time_entries (hotel_id, employee_id, schedule_id, clock_in_at, status, source_in, device_in_id, anomalies)
           VALUES ($1,$2,$3,$4,'open','kiosk',$5,$6) RETURNING id`,
          [hotel.id, employeeId, link?.scheduleId ?? null, t, device.deviceId, JSON.stringify(anomalies)],
        );
        entryId = r.id;
      } catch (err) {
        throw mapDbError(err, { timeEntrySource: 'kiosk' }) ?? err;
      }
    } else {
      if (!open || open.status !== 'open') throw new AppError(open?.status === 'needs_review' ? 'ENTRY_NEEDS_REVIEW' : 'INVALID_PUNCH_STATE');
      entryId = open.id;
      anomalies = open.anomalies ?? [];
      const openBreak = await maybeOne(db, 'SELECT * FROM time_entry_breaks WHERE time_entry_id = $1 AND break_end_at IS NULL', [open.id]);
      if (action === 'break_start') {
        if (s.attendance.breakMode !== 'recorded' || openBreak) throw new AppError('INVALID_PUNCH_STATE');
        await db.query('INSERT INTO time_entry_breaks (time_entry_id, break_start_at) VALUES ($1,$2)', [open.id, t]);
      } else if (action === 'break_end') {
        if (s.attendance.breakMode !== 'recorded' || !openBreak) throw new AppError('INVALID_PUNCH_STATE');
        await db.query('UPDATE time_entry_breaks SET break_end_at = $2 WHERE id = $1', [openBreak.id, t]);
      } else {
        if (openBreak) await db.query('UPDATE time_entry_breaks SET break_end_at = $2 WHERE id = $1', [openBreak.id, t]);
        const clockIn = new Date(open.clock_in_at);
        const gross = (t.getTime() - clockIn.getTime()) / 60_000;
        const entryHotel = open.hotel_id === hotel.id ? hotel : await loadHotel(db, open.hotel_id);
        const es = entryHotel.settings;
        let link: TodayShift | null = null;
        if (open.schedule_id) {
          const sh = await publishedShifts(db, employeeId, addDays(localDate(clockIn, entryHotel.timezone), -1), localDate(clockIn, entryHotel.timezone));
          link = sh.find((x) => x.scheduleId === open.schedule_id) ?? null;
        }
        const entryDate = localDate(clockIn, entryHotel.timezone);
        const others = await dayWorkedMinutes(db, employeeId, entryDate, entryHotel.timezone, open.id);
        let breakMinutes: number;
        const newAnomalies: Anomaly[] = [...clockOutAnomalies(t, link, es.attendance)];
        if (es.attendance.breakMode === 'recorded') {
          const brks = await rows(db, 'SELECT break_start_at, break_end_at FROM time_entry_breaks WHERE time_entry_id = $1', [open.id]);
          breakMinutes = Math.floor(brks.reduce((a, b) => a + (new Date(b.break_end_at ?? t).getTime() - new Date(b.break_start_at).getTime()) / 60_000, 0));
          breakMinutes = Math.min(breakMinutes, Math.max(0, Math.floor(gross) - 1));
          // split day: day total working time; gaps >= 15 min between parts count as break
          const parts = [...others.map((o) => ({ date: entryDate, start: new Date(o.clock_in_at), end: new Date(o.clock_out_at) })), { date: entryDate, start: clockIn, end: t }];
          const dayBreaks = breakMinutes + others.reduce((a, o) => a + o.break_minutes, 0) + gapsBetweenParts(parts).filter((g) => g >= 15).reduce((a, g) => a + g, 0);
          const dayWork = sumWorked(others) + Math.floor(gross) - breakMinutes;
          if (emp.birth_date && ageOn(emp.birth_date, entryDate) < 18) {
            // R18: working time (net) over 4.5 h needs 30 min, over 6 h needs 60 min; only blocks of >= 15 min count
            const block = (m: number) => (m >= 15 ? m : 0);
            const recorded = brks.reduce((a, b) => a + block(Math.floor((new Date(b.break_end_at ?? t).getTime() - new Date(b.break_start_at).getTime()) / 60_000)), 0);
            const counted = recorded + others.reduce((a, o) => a + block(o.break_minutes), 0) + gapsBetweenParts(parts).reduce((a, g) => a + block(g), 0);
            let required = 0;
            for (const rule of es.legal.minors.breakRules) if (dayWork > rule.workingOverHours * 60) required = Math.max(required, rule.minMinutes);
            if (counted < required) newAnomalies.push({ type: 'missing_break', requiredMinutes: required, actualMinutes: Math.round(counted), rule: 'minor' });
          } else {
            const req = requiredBreak(dayWork + breakMinutes, es.legal.breakRules.map((r) => ({ overHours: r.grossOverHours, minMinutes: r.minMinutes })));
            if (dayBreaks < req) newAnomalies.push({ type: 'missing_break', requiredMinutes: req, actualMinutes: Math.round(dayBreaks) });
          }
        } else {
          breakMinutes = autoBreakMinutes(gross, link ? link.breakMinutes : null, es.legal.breakRules);
        }
        const dayWorked = sumWorked(others) + Math.max(0, Math.floor(gross) - breakMinutes);
        if (dayWorked > es.legal.dailyMaxHours * 60) newAnomalies.push({ type: 'exceeds_daily_max', minutes: dayWorked });
        const minor = emp.birth_date && ageOn(emp.birth_date, entryDate) < 18;
        if (minor) {
          if (dayWorked > es.legal.minors.maxDailyHours * 60) newAnomalies.push({ type: 'minor_limit_exceeded', minutes: dayWorked });
          const age = ageOn(emp.birth_date, entryDate);
          const latest = age >= 16 ? es.legal.minors.latestEndHospitality16Plus : es.legal.minors.latestEnd;
          const lt = localTime(t, entryHotel.timezone);
          if (localDate(t, entryHotel.timezone) !== entryDate || lt > latest) newAnomalies.push({ type: 'minor_outside_hours', localTime: lt });
        }
        anomalies = [...anomalies, ...newAnomalies];
        await db.query(
          `UPDATE time_entries SET clock_out_at = $2, break_minutes = $3, status = 'closed', source_out = 'kiosk', device_out_id = $4, anomalies = $5 WHERE id = $1`,
          [open.id, t, breakMinutes, device.deviceId, JSON.stringify(anomalies)],
        );
        if (newAnomalies.some((a) => a.type.startsWith('minor_'))) {
          await notify(db, { userIds: await managerIdsOfHotel(db, open.hotel_id), kind: 'needs_review_entry', params: { timeEntryId: open.id, anomaly: 'minor' }, entityType: 'time_entry', entityId: open.id });
        }
      }
    }
    if (action === 'clock_in' && anomalies.some((a) => a.type.startsWith('minor_'))) {
      await notify(db, { userIds: await managerIdsOfHotel(db, hotel.id), kind: 'needs_review_entry', params: { timeEntryId: entryId, anomaly: 'minor' }, entityType: 'time_entry', entityId: entryId });
    }
    await audit(db, actx, { action: `attendance.${action}`, entityType: 'time_entry', entityId: entryId, hotelId: hotel.id, meta: { deviceId: device.deviceId, anomalies: anomalies.map((a) => a.type) } });
    const todays = await dayWorkedMinutes(db, employeeId, today, hotel.timezone);
    return {
      timeEntryId: entryId,
      action,
      at: t.toISOString(),
      serverTime: t.toISOString(),
      displayName: displayName(emp.first_name, emp.last_name),
      anomalies,
      workedMinutesToday: sumWorked(todays),
    };
  });
}

