import cron from 'node-cron';
import { getPool } from '../db/pool';
import { logger } from '../logger';
import { markNeedsReview } from '../services/attendance';
import { disableTerminatedUsers, inquiryRetention, tokenCleanup } from '../services/retention';
import { sendDueNotificationEmails } from './notificationMailer';

const LOCK_BASE = 4_204_200;

/** Runs fn only if this process wins the Postgres advisory lock (one runner across instances). */
export async function withAdvisoryLock(key: number, fn: () => Promise<unknown>): Promise<boolean> {
  const client = await getPool().connect();
  try {
    const got = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key])).rows[0].ok;
    if (!got) return false;
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
    return true;
  } finally {
    client.release();
  }
}

function job(name: string, key: number, fn: () => Promise<unknown>) {
  return async () => {
    try {
      await withAdvisoryLock(LOCK_BASE + key, fn);
    } catch (err) {
      logger.error({ err, job: name }, 'job failed');
    }
  };
}

export function startJobs(): () => void {
  const db = getPool();
  const tasks = [
    cron.schedule('5 * * * *', job('needsReview', 1, () => markNeedsReview(db))),
    cron.schedule('* * * * *', job('notificationMailer', 2, () => sendDueNotificationEmails(db))),
    cron.schedule('15 3 * * *', job('tokenCleanup', 3, () => tokenCleanup(db))),
    cron.schedule('25 3 * * *', job('inquiryRetention', 4, () => inquiryRetention(db))),
    cron.schedule('35 0 * * *', job('disableTerminatedUsers', 5, () => disableTerminatedUsers(db))),
  ];
  return () => tasks.forEach((t) => void t.stop());
}
