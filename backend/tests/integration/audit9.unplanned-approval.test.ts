import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { anon, as, device } from '../helpers/api';
import { createUser, setupWorld, token, World } from '../helpers/fixtures';
import { q, q1 } from '../helpers/db';
import { closePool, getPool } from '../../src/db/pool';
import { setNow } from '../../src/clock';
import { markNeedsReview } from '../../src/services/attendance';

let w: World;
let dev: string;
const M1 = () => as(w.tokens.manager1);
const ADMIN = () => as(w.tokens.admin);

async function setup() {
  w = await setupWorld();
  const code = await M1().post('/kiosk/pairing-codes', { hotelId: w.h1, deviceName: 'Tablet' });
  dev = (await anon.post('/kiosk/pair', { pairingCode: code.body.pairingCode })).body.deviceToken;
}
const pin = async (e: number) => (await M1().post(`/employees/${e}/pin/reset`)).body.pin as string;
const verify = async (e: number, p: string) => (await device(dev).post('/kiosk/verify', { employeeId: e, pin: p })).body;
const punch = (token: string, action: string, reason?: string) => device(dev).post('/kiosk/punch', { punchToken: token, action, ...(reason === undefined ? {} : { reason }) });

/** Unplanned day: clock in 12:00 local (no shift), out 16:30 → 4.5 h (270 min); no automatic break below 6 h of gross time. */
async function unplannedDay(employeeId: number, reason = 'Covering a sick colleague') {
  const p = await pin(employeeId);
  setNow('2026-10-01T10:00:00Z'); // 12:00 local
  const v = await verify(employeeId, p);
  expect((await punch(v.punchToken, 'clock_in', reason)).status).toBe(201);
  setNow('2026-10-01T14:30:00Z'); // 16:30 local
  const v2 = await verify(employeeId, p);
  const out = await punch(v2.punchToken, 'clock_out');
  expect(out.status).toBe(201);
  return out.body.timeEntryId as number;
}

describe('SPEC 1.12: unplanned clock-in needs a reason and supervisor approval', () => {
  beforeEach(setup);
  afterAll(() => closePool());

  it('the tablet is told whether a reason is needed; the refusal keeps the PIN check usable', async () => {
    const p = await pin(w.maria);
    setNow('2026-10-01T10:00:00Z');
    const unplanned = await verify(w.maria, p);
    expect(unplanned).toMatchObject({ status: 'not_in', allowedActions: ['clock_in'], reasonRequiredForClockIn: true });
    // no reason / blank / too short → 422, and the SAME punch token still works afterwards
    for (const reason of [undefined, '', '   ', 'ab']) {
      const r = await punch(unplanned.punchToken, 'clock_in', reason);
      expect(r.status, String(reason)).toBe(422);
      expect(r.body.error.code).toBe('UNPLANNED_REASON_REQUIRED');
    }
    expect((await q('SELECT 1 FROM time_entries')).length).toBe(0);
    const ok = await punch(unplanned.punchToken, 'clock_in', '  Covering for Jon, agreed with the shift lead  ');
    expect(ok.status).toBe(201);
    expect(ok.body.anomalies).toEqual([{ type: 'unscheduled_work' }]);
    expect((await punch(unplanned.punchToken, 'clock_out')).body.error.code).toBe('PUNCH_TOKEN_INVALID'); // burnt by the success
    const row = await q1('SELECT unplanned_reason, approval_status, schedule_id FROM time_entries');
    expect(row).toEqual({ unplanned_reason: 'Covering for Jon, agreed with the shift lead', approval_status: 'pending', schedule_id: null });
    setNow('2026-10-01T11:00:00Z');
    expect((await punch((await verify(w.maria, p)).punchToken, 'clock_out', 'x')).status).toBe(201); // reason is ignored for other actions
  });

  it('a planned shift needs no reason and no approval; a reason sent anyway is not stored', async () => {
    await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.maria, shiftId: w.early, date: '2026-10-01' });
    await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-01', to: '2026-10-01' });
    const p = await pin(w.maria);
    setNow('2026-10-01T04:00:00Z');
    const v = await verify(w.maria, p);
    expect(v.reasonRequiredForClockIn).toBe(false);
    expect((await punch(v.punchToken, 'clock_in')).status).toBe(201); // no reason at all
    expect(await q1('SELECT unplanned_reason, approval_status FROM time_entries')).toEqual({ unplanned_reason: null, approval_status: 'not_required' });
    // the second part of the day (no second shift) is unplanned again
    setNow('2026-10-01T08:00:00Z');
    await punch((await verify(w.maria, p)).punchToken, 'clock_out');
    setNow('2026-10-01T09:00:00Z');
    const again = await verify(w.maria, p);
    expect(again.reasonRequiredForClockIn).toBe(true);
    // a shift at ANOTHER hotel does not count as a plan here
    await q(`DELETE FROM time_entries`);
    await M1().post('/schedules', { hotelId: w.h1, entryType: 'shift', employeeId: w.flo, shiftId: w.early, date: '2026-10-01' });
    await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-01', to: '2026-10-01' });
    const code2 = await as(w.tokens.manager2).post('/kiosk/pairing-codes', { hotelId: w.h2, deviceName: 'Munich' });
    const dev2 = (await anon.post('/kiosk/pair', { pairingCode: code2.body.pairingCode })).body.deviceToken;
    const pf = (await M1().post(`/employees/${w.flo}/pin/reset`)).body.pin;
    setNow('2026-10-01T04:00:00Z');
    const v2 = (await device(dev2).post('/kiosk/verify', { employeeId: w.flo, pin: pf })).body;
    expect(v2.reasonRequiredForClockIn).toBe(true);
  });

  it('unapproved hours do not count anywhere until a supervisor approves them', async () => {
    const entryId = await unplannedDay(w.maria);
    const hours = async () => ({
      account: (await as(w.tokens.maria).get('/employees/me/time-account?from=2026-10&to=2026-10')).body.months[0].workedHours,
      dashboard: (await as(w.tokens.maria).get('/me/dashboard')).body.week.workedHours,
      payroll: (await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-10&format=json`)).body,
    });
    const before = await hours();
    expect(before.account).toBe(0);
    expect(before.dashboard).toBe(0);
    expect(before.payroll.data[0]).toMatchObject({ workedMinutes: 0, unapprovedEntries: 1 });
    expect(before.payroll.warnings).toContain('entries_pending_approval');
    expect((await M1().get(`/hotels/${w.h1}/analytics/attendance?from=2026-10-01&to=2026-10-31`)).body.byEmployee[0]).toMatchObject({ actualPaidHours: 0, entriesAwaitingApproval: 1, unscheduledCount: 1 });
    const live = await M1().get('/attendance/live');
    expect(live.body.awaitingApproval).toEqual([{ timeEntryId: entryId, employee: { id: w.maria, displayName: 'Maria G.' }, clockInAt: expect.any(String), clockOutAt: expect.any(String), reason: 'Covering a sick colleague' }]);
    expect((await as(w.tokens.maria).get('/me/dashboard')).body.pending.timeEntriesAwaitingApproval).toBe(1);
    // the manager was told when the hours became final
    expect((await q(`SELECT user_id FROM notifications WHERE kind = 'time_approval_requested' ORDER BY user_id`)).map((n) => n.user_id)).toEqual([w.manager1, w.regional].sort((a, b) => a - b));
    // the employee sees reason and status
    const mine = await as(w.tokens.maria).get(`/attendance/${entryId}`);
    expect(mine.body).toMatchObject({ approvalStatus: 'pending', unplannedReason: 'Covering a sick colleague', workedMinutes: 270 });
    expect((await as(w.tokens.maria).get('/attendance?from=2026-10-01&to=2026-10-31&approvalStatus=pending')).body.data).toHaveLength(1);
    expect((await as(w.tokens.maria).get('/attendance?from=2026-10-01&to=2026-10-31&approvalStatus=approved')).body.data).toHaveLength(0);

    const approved = await M1().patch(`/attendance/${entryId}/approval`, { status: 'approved', note: 'Confirmed with the shift lead' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ approvalStatus: 'approved', approvedById: w.manager1, approvalNote: 'Confirmed with the shift lead' });
    const after = await hours();
    expect(after.account).toBe(4.5);
    expect(after.dashboard).toBe(4.5);
    expect(after.payroll.data[0]).toMatchObject({ workedMinutes: 270, unapprovedEntries: 0 });
    expect(after.payroll.warnings).not.toContain('entries_pending_approval');
    expect((await q(`SELECT user_id FROM notifications WHERE kind = 'time_approval_decided'`)).map((n) => n.user_id)).toEqual([w.uMaria]);
    expect((await M1().get('/attendance/live')).body.awaitingApproval).toEqual([]);
    expect((await q(`SELECT meta FROM audit_logs WHERE action = 'attendance.approval_approved'`))[0].meta.workedMinutes).toBe(270);
  });

  it('rejection needs a note, removes the hours, and decisions can be revised', async () => {
    const id = await unplannedDay(w.maria);
    expect((await M1().patch(`/attendance/${id}/approval`, { status: 'rejected' })).status).toBe(400);
    expect((await M1().patch(`/attendance/${id}/approval`, { status: 'rejected', note: '  ' })).status).toBe(400);
    const rej = await M1().patch(`/attendance/${id}/approval`, { status: 'rejected', note: 'Not agreed with the supervisor' });
    expect(rej.body).toMatchObject({ approvalStatus: 'rejected', approvalNote: 'Not agreed with the supervisor' });
    expect((await as(w.tokens.maria).get('/employees/me/time-account?from=2026-10&to=2026-10')).body.months[0].workedHours).toBe(0);
    expect((await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-10&format=json`)).body.data[0]).toMatchObject({ workedMinutes: 0, unapprovedEntries: 1 });
    expect((await M1().patch(`/attendance/${id}/approval`, { status: 'rejected', note: 'again' })).body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect((await M1().patch(`/attendance/${id}/approval`, { status: 'approved' })).status).toBe(200); // revised
    expect((await as(w.tokens.maria).get('/employees/me/time-account?from=2026-10&to=2026-10')).body.months[0].workedHours).toBe(4.5);
    expect((await M1().patch(`/attendance/${id}/approval`, { status: 'rejected', note: 'wrong' })).status).toBe(200); // and back
  });

  it('only closed unplanned entries can be decided; planned ones never', async () => {
    const p = await pin(w.maria);
    setNow('2026-10-01T10:00:00Z');
    await punch((await verify(w.maria, p)).punchToken, 'clock_in', 'Unplanned cover');
    const open = (await q1('SELECT id FROM time_entries')).id;
    const tooEarly = await M1().patch(`/attendance/${open}/approval`, { status: 'approved' });
    expect(tooEarly.status).toBe(422);
    expect(tooEarly.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    // a forgotten clock-out: needs_review → manager closes it with a correction → approval can follow
    setNow('2026-10-02T06:00:00Z');
    expect(await markNeedsReview(getPool())).toBe(1);
    expect((await M1().patch(`/attendance/${open}/approval`, { status: 'approved' })).status).toBe(422);
    await M1().patch(`/attendance/${open}`, { clockOutAt: '2026-10-01T14:00:00Z', breakMinutes: 0, reason: 'Left at 16:00, confirmed' });
    expect((await M1().get(`/attendance/${open}`)).body.approvalStatus).toBe('pending'); // closing does not approve
    expect((await M1().patch(`/attendance/${open}/approval`, { status: 'approved' })).status).toBe(200);
    // manual entries by a manager are decisions already; planned entries need none
    const manual = await M1().post('/attendance', { hotelId: w.h1, employeeId: w.jon, clockInAt: '2026-09-07T06:00:00Z', clockOutAt: '2026-09-07T14:00:00Z', breakMinutes: 30, reason: 'import' });
    expect(manual.body.approvalStatus).toBe('not_required');
    const nr = await M1().patch(`/attendance/${manual.body.id}/approval`, { status: 'approved' });
    expect(nr.status).toBe(422);
    expect((await M1().get(`/hotels/${w.h1}/payroll-export?month=2026-09&format=json`)).body.data[0]).toMatchObject({ workedMinutes: 450, unapprovedEntries: 0 });
  });

  it('authorisation: staff no, other hotel no, nobody approves their own hours except an admin', async () => {
    const id = await unplannedDay(w.maria);
    expect((await as(w.tokens.maria).patch(`/attendance/${id}/approval`, { status: 'approved' })).status).toBe(403);
    expect((await as(w.tokens.manager2).patch(`/attendance/${id}/approval`, { status: 'approved' })).status).toBe(404);
    expect((await anon.patch(`/attendance/${id}/approval`, { status: 'approved' })).status).toBe(401);
    // a manager who is also an employee
    const emp = (await q1(`INSERT INTO employees (company_id, first_name, last_name) VALUES ($1,'Manny','Both') RETURNING id`, [w.companyId])).id;
    await q(`INSERT INTO employee_hotels (employee_id, hotel_id, company_id, is_home, assigned_on) VALUES ($1,$2,$3,true,'2026-01-01')`, [emp, w.h1, w.companyId]);
    const mu = await createUser({ companyId: w.companyId, role: 'manager', email: 'both@tripinn.test', employeeId: emp, hotelIds: [w.h1] });
    const mt = await token(mu);
    const own = await unplannedDay(emp, 'Opening the bar early');
    const self = await as(mt).patch(`/attendance/${own}/approval`, { status: 'approved' });
    expect(self.status).toBe(403);
    expect((await as(await token(w.manager1)).patch(`/attendance/${own}/approval`, { status: 'approved' })).status).toBe(200);
    expect((await ADMIN().patch(`/attendance/${id}/approval`, { status: 'approved' })).status).toBe(200);
  });

  it('decisions inside a locked payroll period need an admin with a reason', async () => {
    const id = await unplannedDay(w.maria);
    await M1().put(`/hotels/${w.h1}/attendance-lock`, { lockedUntil: '2026-10-01' });
    const manager = await M1().patch(`/attendance/${id}/approval`, { status: 'approved' });
    expect(manager.status).toBe(423);
    expect(manager.body.error.code).toBe('PERIOD_LOCKED');
    expect((await ADMIN().patch(`/attendance/${id}/approval`, { status: 'approved' })).status).toBe(423); // no reason given
    expect((await ADMIN().patch(`/attendance/${id}/approval`, { status: 'approved', note: 'Payroll office request #7' })).status).toBe(200);
    expect((await q(`SELECT meta FROM audit_logs WHERE action = 'attendance.approval_approved'`))[0].meta).toMatchObject({ lockOverride: true });
  });

  it('database guards: reason mandatory for pending, decided entries carry a decision time', async () => {
    const id = await unplannedDay(w.maria);
    await expect(q(`UPDATE time_entries SET unplanned_reason = NULL WHERE id = $1`, [id])).rejects.toThrow(/chk_unplanned_reason/);
    await expect(q(`UPDATE time_entries SET approval_status = 'approved' WHERE id = $1`, [id])).rejects.toThrow(/chk_approval_decided/);
    await expect(q(`UPDATE time_entries SET approval_status = 'maybe' WHERE id = $1`, [id])).rejects.toThrow();
  });

  it('e-mail for the decision is generic and respects preferences', async () => {
    const id = await unplannedDay(w.maria);
    await M1().patch(`/attendance/${id}/approval`, { status: 'rejected', note: 'private reason text' });
    const n = (await as(w.tokens.maria).get('/notifications')).body.data.find((x: any) => x.kind === 'time_approval_decided');
    expect(n.params).toEqual({ status: 'rejected', timeEntryId: id }); // ids only: no note text
    expect(JSON.stringify(n)).not.toContain('private reason');
  });
});
