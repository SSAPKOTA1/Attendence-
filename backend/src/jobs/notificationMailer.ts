import { Db, rows } from '../db/pool';
import { now } from '../clock';
import { config } from '../config';
import { mailer } from '../services/mailer';

const MAX_ATTEMPTS = 3;

/** R17: generic text + link only, never the content; retried up to 3 times. */
export async function sendDueNotificationEmails(db: Db, batch = 100): Promise<number> {
  const due = await rows(
    db,
    `SELECT n.id, n.kind, u.email, u.preferred_language FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.email_due AND n.emailed_at IS NULL AND n.email_attempts < $1 AND u.email IS NOT NULL AND u.status = 'active'
      ORDER BY n.created_at LIMIT $2`,
    [MAX_ATTEMPTS, batch],
  );
  let sent = 0;
  for (const n of due) {
    const de = n.preferred_language !== 'en';
    try {
      await mailer.send({
        to: n.email,
        subject: de ? 'Neue Benachrichtigung im Dienstplan' : 'New roster notification',
        text: (de ? 'Es gibt eine neue Benachrichtigung für dich: ' : 'You have a new notification: ') + `${config.APP_URL.replace(/\/$/, '')}/notifications`,
      });
      await db.query('UPDATE notifications SET emailed_at = $2, email_attempts = email_attempts + 1 WHERE id = $1', [n.id, now()]);
      sent++;
    } catch {
      await db.query('UPDATE notifications SET email_attempts = email_attempts + 1 WHERE id = $1', [n.id]);
    }
  }
  return sent;
}
