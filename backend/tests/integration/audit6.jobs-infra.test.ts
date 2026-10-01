import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app, as } from '../helpers/api';
import { setupWorld, World } from '../helpers/fixtures';
import { q } from '../helpers/db';
import { closePool, getPool } from '../../src/db/pool';
import { startJobs, withAdvisoryLock } from '../../src/jobs';
import { sendDueNotificationEmails } from '../../src/jobs/notificationMailer';
import { mailer, MemoryMailer } from '../../src/services/mailer';
import { RateLimiter } from '../../src/middleware/rateLimit';
import { notify } from '../../src/services/notifications';

let w: World;
const mem = mailer as MemoryMailer;

describe('audit 6: jobs, mail retry, rate limiter, request ids', () => {
  beforeEach(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('advisory lock: only one runner at a time, lock is released afterwards', async () => {
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 150));
      running--;
    };
    const results = await Promise.all([withAdvisoryLock(777001, task), withAdvisoryLock(777001, task), withAdvisoryLock(777001, task)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(maxRunning).toBe(1);
    expect(await withAdvisoryLock(777001, async () => undefined)).toBe(true); // released
    // a failing task still releases the lock
    await expect(withAdvisoryLock(777002, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withAdvisoryLock(777002, async () => undefined)).toBe(true);
  });

  it('startJobs schedules and stops cleanly', () => {
    const stop = startJobs();
    expect(typeof stop).toBe('function');
    stop();
  });

  it('notification e-mail: retries up to 3 times, then gives up; success marks it sent', async () => {
    await notify(getPool(), { userIds: [w.uMaria], kind: 'roster_entry_changed', params: { date: '2026-10-05' } });
    expect((await q('SELECT email_due FROM notifications'))[0].email_due).toBe(true);
    mem.outbox.length = 0;
    mem.failNext = 2;
    expect(await sendDueNotificationEmails(getPool())).toBe(0);
    expect(await sendDueNotificationEmails(getPool())).toBe(0);
    expect((await q('SELECT email_attempts, emailed_at FROM notifications'))[0]).toMatchObject({ email_attempts: 2, emailed_at: null });
    expect(await sendDueNotificationEmails(getPool())).toBe(1); // third attempt succeeds
    expect(mem.outbox).toHaveLength(1);
    expect(await sendDueNotificationEmails(getPool())).toBe(0); // never sent twice
    await notify(getPool(), { userIds: [w.uMaria], kind: 'roster_entry_removed' });
    mem.failNext = 5;
    for (let i = 0; i < 5; i++) await sendDueNotificationEmails(getPool());
    expect((await q(`SELECT email_attempts, emailed_at FROM notifications WHERE kind = 'roster_entry_removed'`))[0]).toMatchObject({ email_attempts: 3, emailed_at: null });
    mem.failNext = 0;
  });

  it('e-mail text is generic: no roster content, only a link; users without e-mail get in-app only', async () => {
    await notify(getPool(), { userIds: [w.uJon], kind: 'roster_entry_changed', params: { date: '2026-10-05' } }); // jon has no e-mail
    expect((await q('SELECT email_due FROM notifications'))[0].email_due).toBe(false);
    await notify(getPool(), { userIds: [w.uMaria], kind: 'absence_decided', params: { status: 'approved' } });
    mem.outbox.length = 0;
    await sendDueNotificationEmails(getPool());
    expect(mem.outbox[0].text).not.toMatch(/approved|2026-10-05|sick|krank/i);
    expect(mem.outbox[0].text).toMatch(/https:\/\/app\.example\/notifications/);
  });

  it('RateLimiter: window, per-key isolation and reset', () => {
    const rl = new RateLimiter(3, 60_000);
    expect([1, 2, 3, 4].map(() => rl.hit('a'))).toEqual([true, true, true, false]);
    expect(rl.hit('b')).toBe(true);
    rl.reset('a');
    expect(rl.hit('a')).toBe(true);
    const short = new RateLimiter(1, 20);
    expect(short.hit('x')).toBe(true);
    expect(short.hit('x')).toBe(false);
    return new Promise<void>((resolve) => setTimeout(() => { expect(short.hit('x')).toBe(true); resolve(); }, 40));
  });

  it('request ids: a valid X-Request-Id is echoed, junk is replaced; every error carries it', async () => {
    const ok = await request(app).get('/api/v1/health').set('X-Request-Id', 'abc12345-trace');
    expect(ok.headers['x-request-id']).toBe('abc12345-trace');
    const junk = await request(app).get('/api/v1/health').set('X-Request-Id', 'bad id with spaces & <script>');
    expect(junk.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const err = await as(w.tokens.maria).get('/hotels');
    expect(err.body.error.requestId).toBe(err.headers['x-request-id']);
  });

  it('language: user preference wins over Accept-Language; fallback is German', async () => {
    const de = await as(w.tokens.maria).get('/hotels');
    expect(de.body.error.message).toBe('Dazu fehlt die Berechtigung.');
    await as(w.tokens.maria).patch('/me/profile', { preferredLanguage: 'en' });
    const en = await as(w.tokens.maria).get('/hotels', { 'Accept-Language': 'de' });
    expect(en.body.error.message).toBe('You are not allowed to do this.');
  });
});
