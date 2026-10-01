import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { setupWorld, World } from '../helpers/fixtures';
import { q, q1 } from '../helpers/db';
import { closePool, getPool } from '../../src/db/pool';
import { sendDueNotificationEmails } from '../../src/jobs/notificationMailer';
import { mailer, MemoryMailer } from '../../src/services/mailer';
import { setNow } from '../../src/clock';

let w: World;
const M1 = () => as(w.tokens.manager1);
const outbox = () => (mailer as MemoryMailer).outbox;

function entry(employeeId: number, shiftId: number, date: string, hotelId?: number) {
  return { hotelId: hotelId ?? w.h1, entryType: 'shift', employeeId, shiftId, date };
}

describe('Phase 8: employee portal, notifications, inquiries', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('#100 staff reads own work summary / another employee’s', async () => {
    expect((await as(w.tokens.maria).get('/employees/me/work-summary')).status).toBe(200);
    expect((await as(w.tokens.maria).get(`/employees/${w.maria}/work-summary`)).status).toBe(200);
    const other = await as(w.tokens.maria).get(`/employees/${w.jon}/work-summary`);
    expect(other.status).toBe(404);
  });

  it('#101 staff list only their own shift and leave wishes', async () => {
    await as(w.tokens.maria).post('/employees/me/shift-wishes', { date: '2026-10-08', kind: 'avoid' });
    await as(w.tokens.jon).post('/employees/me/shift-wishes', { date: '2026-10-08', kind: 'avoid' });
    await as(w.tokens.maria).post('/employees/me/leave-wishes', { startDate: '2026-11-02', endDate: '2026-11-03' });
    await as(w.tokens.jon).post('/employees/me/leave-wishes', { startDate: '2026-11-02', endDate: '2026-11-03' });
    const sw = await as(w.tokens.maria).get(`/shift-wishes?hotelId=${w.h1}`);
    expect(sw.body.data.map((x: any) => x.employeeId)).toEqual([w.maria]);
    const lw = await as(w.tokens.maria).get('/leave-wishes');
    expect(lw.body.data.map((x: any) => x.employeeId)).toEqual([w.maria]);
    const mgr = await M1().get('/shift-wishes');
    expect(mgr.body.data).toHaveLength(2);
  });

  it('#102 own_departments plan: names "Maria G.", shifts only, no drafts, no other departments', async () => {
    await M1().post('/schedules', entry(w.maria, w.early, '2026-10-05'));
    await M1().post('/schedules', entry(w.flo, w.late, '2026-10-05'));
    await M1().post('/schedules', entry(w.jon, w.hk, '2026-10-05'));
    await M1().post('/schedules', { hotelId: w.h1, entryType: 'off', employeeId: w.jon, date: '2026-10-06', offLabel: 'Frei' });
    await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-05', to: '2026-10-11' });
    await M1().post('/schedules', entry(w.flo, w.early, '2026-10-07')); // draft
    const plan = await as(w.tokens.maria).get('/schedules?from=2026-10-05&to=2026-10-11');
    expect(plan.status).toBe(200);
    expect(plan.body.data).toEqual([
      { date: '2026-10-05', department: { id: w.d1, name: 'Front Desk' }, shift: { name: 'Early', startTime: '06:00', endTime: '14:00' }, employee: { displayName: 'Maria G.' }, isMine: true },
      { date: '2026-10-05', department: { id: w.d1, name: 'Front Desk' }, shift: { name: 'Late', startTime: '14:00', endTime: '22:00' }, employee: { displayName: 'Flo W.' }, isMine: false },
    ]);
    const jonPlan = await as(w.tokens.jon).get('/schedules?from=2026-10-05&to=2026-10-11');
    expect(jonPlan.body.data.map((x: any) => x.shift.name).sort()).toEqual(['Early', 'Housekeeping', 'Late']);
    expect((await as(w.tokens.maria).get(`/schedules?employeeId=${w.jon}&from=2026-10-05&to=2026-10-11`)).status).toBe(404);
  });

  it('#103 dashboard numbers equal the underlying endpoints', async () => {
    await M1().post('/schedules', entry(w.maria, w.early, '2026-10-02'));
    await M1().post('/schedules', entry(w.maria, w.late, '2026-10-05'));
    await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-01', to: '2026-10-11' });
    await M1().post(`/employees/${w.maria}/time-offs`, { type: 'annual_leave', startDate: '2026-12-21', endDate: '2026-12-23' });
    await as(w.tokens.maria).post('/employees/me/time-offs', { type: 'annual_leave', startDate: '2026-12-28', endDate: '2026-12-29' });
    await M1().post('/attendance', { hotelId: w.h1, employeeId: w.maria, clockInAt: '2026-09-28T06:00:00Z', clockOutAt: '2026-09-28T14:00:00Z', breakMinutes: 30, reason: 'import' });
    const dash = await as(w.tokens.maria).get('/me/dashboard');
    expect(dash.status).toBe(200);
    const allowance = await as(w.tokens.maria).get('/employees/me/vacation-allowance?year=2026');
    expect(dash.body.vacation).toEqual({ year: 2026, remainingDays: allowance.body.remainingDays, pendingDays: allowance.body.pendingDays, usedDays: allowance.body.usedDays });
    expect(dash.body.vacation).toMatchObject({ usedDays: 3, pendingDays: 2 });
    const account = await as(w.tokens.maria).get('/employees/me/time-account');
    expect(dash.body.timeAccount.balanceHours).toBe(account.body.balanceHours);
    const summary = await as(w.tokens.maria).get('/employees/me/work-summary?from=2026-09-28&to=2026-10-04');
    expect(dash.body.week.plannedHours).toBe(summary.body.scheduledPaidHours);
    expect(dash.body.week.workedHours).toBe(7.5);
    expect(dash.body.nextShifts[0]).toMatchObject({ date: '2026-10-02', shiftName: 'Early', hotelName: 'Trip Inn Frankfurt' });
    expect(dash.body.pending.timeOffs).toBe(1);
    expect(dash.body.planPublishedUntil).toEqual([{ hotelId: w.h1, hotelName: 'Trip Inn Frankfurt', date: '2026-10-05' }]);
    expect(dash.body.today).toMatchObject({ status: 'not_in', shifts: [] });
  });

  it('#104 staff patches phone/language; name and rate are ignored', async () => {
    const res = await as(w.tokens.maria).patch('/me/profile', { phone: '+49 151 000', preferredLanguage: 'en', firstName: 'Hacker', hourlyRate: 99 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ phone: '+49 151 000', preferredLanguage: 'en', firstName: 'Maria' });
    const emp = await q1('SELECT first_name, hourly_rate FROM employees WHERE id = $1', [w.maria]);
    expect(emp).toEqual({ first_name: 'Maria', hourly_rate: 15.5 });
    const profile = await as(w.tokens.maria).get('/me/profile');
    expect(profile.body).toMatchObject({ employeeNumber: 'P100', homeHotel: { id: w.h1, name: 'Trip Inn Frankfurt' }, birthDate: null });
    const err = await as(w.tokens.maria).get(`/employees/${w.jon}/work-summary`);
    expect(err.body.error.message).toBe('Not found.');
  });

  it('#105 publish → roster_published; change in notice window → urgent; e-mail per preference', async () => {
    const a = await M1().post('/schedules', entry(w.maria, w.early, '2026-10-02'));
    await M1().post('/schedules', entry(w.maria, w.early, '2026-10-05'));
    await M1().post('/schedules', entry(w.jon, w.late, '2026-10-02'));
    await M1().post('/schedules/publish', { hotelId: w.h1, from: '2026-10-01', to: '2026-10-11' });
    const pub = await q(`SELECT user_id, email_due FROM notifications WHERE kind = 'roster_published' ORDER BY user_id`);
    expect(pub).toEqual([{ user_id: w.uMaria, email_due: false }, { user_id: w.uJon, email_due: false }]);
    await M1().patch(`/schedules/${a.body.id}`, { shiftId: w.late });
    const list = await as(w.tokens.maria).get('/notifications?unread=true');
    expect(list.body.meta.unread).toBe(2);
    const changed = list.body.data.find((n: any) => n.kind === 'roster_entry_changed');
    expect(changed).toMatchObject({ urgent: true, entityType: 'schedule', entityId: a.body.id, params: { date: '2026-10-02' } });
    expect((await as(w.tokens.maria).patch(`/notifications/${changed.id}`, { read: true })).body.readAt).toBeTruthy();
    expect((await as(w.tokens.jon).patch(`/notifications/${changed.id}`, { read: true })).status).toBe(404);
    const before = outbox().length;
    expect(await sendDueNotificationEmails(getPool())).toBe(1);
    const mail = outbox()[before];
    expect(mail.to).toBe('maria@tripinn.test');
    expect(mail.text).not.toContain('Early');
    const prefs = await as(w.tokens.maria).put('/me/notification-preferences', { roster_entry_changed: { email: false } });
    expect(prefs.body.roster_entry_changed).toEqual({ email: false });
    expect(prefs.body.sick_reported).toEqual({ email: true });
    const j = await q1(`SELECT id FROM schedules WHERE employee_id = $1`, [w.jon]);
    await M1().patch(`/schedules/${j.id}`, { shiftId: w.early });
    await M1().patch(`/schedules/${a.body.id}`, { shiftId: w.early });
    const due = await q(`SELECT user_id FROM notifications WHERE kind = 'roster_entry_changed' AND email_due AND emailed_at IS NULL`);
    expect(due).toEqual([]); // jon has no e-mail, maria opted out
    expect((await as(w.tokens.maria).post('/notifications/read-all')).body.updated).toBeGreaterThan(0);
  });

  it('#107 inquiry routing: home hotel / entry at hotel 2', async () => {
    const home = await as(w.tokens.flo).post('/inquiries', { subject: 'Vacation balance', category: 'vacation', body: 'How many days are left?' });
    expect(home.status).toBe(201);
    expect(home.body).toMatchObject({ status: 'open', hotelId: w.h1 });
    const s = await as(w.tokens.manager2).post('/schedules', entry(w.flo, w.early2, '2026-10-05', w.h2));
    const away = await as(w.tokens.flo).post('/inquiries', { subject: 'Shift at Munich', category: 'roster', body: 'Can I start later?', related: { type: 'schedule', id: s.body.id } });
    expect(away.body.hotelId).toBe(w.h2);
    const n1 = await q(`SELECT user_id FROM notifications WHERE kind = 'inquiry_new' AND entity_id = $1 ORDER BY user_id`, [home.body.id]);
    expect(n1.map((n) => n.user_id)).toEqual([w.manager1, w.regional].sort((a, b) => a - b));
    const n2 = await q(`SELECT user_id FROM notifications WHERE kind = 'inquiry_new' AND entity_id = $1 ORDER BY user_id`, [away.body.id]);
    expect(n2.map((n) => n.user_id)).toEqual([w.manager2, w.regional].sort((a, b) => a - b));
    expect((await M1().get(`/inquiries/${away.body.id}`)).status).toBe(404);
    expect((await as(w.tokens.manager2).get(`/inquiries/${away.body.id}`)).status).toBe(200);
    const notMine = await as(w.tokens.maria).post('/inquiries', { subject: 'x', category: 'roster', body: 'y', related: { type: 'schedule', id: s.body.id } });
    expect(notMine.status).toBe(404);
  });

  it('#108 status flow answered → open → closed → reopened, with notifications', async () => {
    const i = await as(w.tokens.maria).post('/inquiries', { subject: 'Break deducted?', category: 'attendance', body: 'Why?' });
    const reply = await M1().post(`/inquiries/${i.body.id}/messages`, { body: 'Because of the 6 h rule.' });
    expect(reply.status).toBe(201);
    expect(reply.body.status).toBe('answered');
    expect((await q(`SELECT 1 FROM notifications WHERE kind = 'inquiry_reply' AND user_id = $1`, [w.uMaria])).length).toBe(1);
    const back = await as(w.tokens.maria).post(`/inquiries/${i.body.id}/messages`, { body: 'Thanks, understood.' });
    expect(back.body.status).toBe('open');
    const closed = await as(w.tokens.maria).patch(`/inquiries/${i.body.id}`, { status: 'closed' });
    expect(closed.body.status).toBe('closed');
    const reopened = await as(w.tokens.maria).post(`/inquiries/${i.body.id}/messages`, { body: 'One more question.' });
    expect(reopened.body.status).toBe('open');
    expect(reopened.body.messages.map((m: any) => m.author.role)).toEqual(['staff', 'manager', 'staff', 'staff']);
    expect(reopened.body.employee).toEqual({ id: w.maria, displayName: 'Maria G.' });
    const assign = await M1().patch(`/inquiries/${i.body.id}`, { assignedToId: w.manager1 });
    expect(assign.body.assignedTo.id).toBe(w.manager1);
    expect((await as(w.tokens.maria).patch(`/inquiries/${i.body.id}`, { assignedToId: w.manager1 })).status).toBe(403);
    const audit = await q(`SELECT before, after, meta FROM audit_logs WHERE entity_type = 'inquiry'`);
    expect(JSON.stringify(audit)).not.toContain('Thanks, understood');
  });

  it('#109 other employee / manager of another hotel → 404', async () => {
    const i = await as(w.tokens.maria).post('/inquiries', { subject: 'Private', category: 'other', body: 'Hello' });
    expect((await as(w.tokens.jon).get(`/inquiries/${i.body.id}`)).status).toBe(404);
    expect((await as(w.tokens.manager2).get(`/inquiries/${i.body.id}`)).status).toBe(404);
    expect((await as(w.tokens.jon).post(`/inquiries/${i.body.id}/messages`, { body: 'x' })).status).toBe(404);
    const list = await as(w.tokens.jon).get('/inquiries');
    expect(list.body.data).toEqual([]);
  });

  it('#110 empty / over-long body → 400; 21st inquiry in a day → 429', async () => {
    expect((await as(w.tokens.maria).post('/inquiries', { subject: 'S', body: '   ' })).status).toBe(400);
    expect((await as(w.tokens.maria).post('/inquiries', { subject: 'S', body: 'x'.repeat(4001) })).status).toBe(400);
    for (let i = 0; i < 20; i++) {
      const r = await as(w.tokens.maria).post('/inquiries', { subject: `Q${i}`, body: 'question' });
      expect(r.status).toBe(201);
    }
    const res = await as(w.tokens.maria).post('/inquiries', { subject: 'Q21', body: 'question' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    setNow('2026-10-02T07:00:00Z');
    expect((await as(w.tokens.maria).post('/inquiries', { subject: 'next day', body: 'question' })).status).toBe(201);
  });
});
