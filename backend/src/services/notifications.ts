import { Db, rows } from '../db/pool';

export const NOTIFICATION_KINDS = [
  'roster_published', 'roster_entry_changed', 'roster_entry_removed', 'absence_decided', 'wish_decided',
  'correction_decided', 'inquiry_reply', 'inquiry_new', 'absence_requested', 'wish_submitted',
  'correction_requested', 'needs_review_entry', 'sick_reported', 'time_approval_requested', 'time_approval_decided',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** R17 defaults: e-mail on for changes/removals, decisions, replies and sick reports. */
export const EMAIL_DEFAULTS: Record<NotificationKind, boolean> = {
  roster_published: false,
  roster_entry_changed: true,
  roster_entry_removed: true,
  absence_decided: true,
  wish_decided: true,
  correction_decided: true,
  inquiry_reply: true,
  inquiry_new: false,
  absence_requested: false,
  wish_submitted: false,
  correction_requested: false,
  needs_review_entry: false,
  sick_reported: true,
  time_approval_requested: false,
  time_approval_decided: true,
};

export interface NotifyInput {
  userIds: number[];
  kind: NotificationKind;
  /** ids and dates only, never health details or free text */
  params?: Record<string, unknown>;
  entityType?: string;
  entityId?: number | null;
  urgent?: boolean;
}

export async function notify(db: Db, n: NotifyInput): Promise<void> {
  const ids = [...new Set(n.userIds)];
  if (ids.length === 0) return;
  const users = await rows(
    db,
    `SELECT u.id, u.email, p.email AS pref
       FROM users u LEFT JOIN notification_preferences p ON p.user_id = u.id AND p.kind = $2
      WHERE u.id = ANY($1::bigint[]) AND u.deleted_at IS NULL AND u.status <> 'disabled'`,
    [ids, n.kind],
  );
  for (const u of users) {
    const wantsEmail = u.pref === null || u.pref === undefined ? EMAIL_DEFAULTS[n.kind] : u.pref;
    await db.query(
      `INSERT INTO notifications (user_id, kind, params, entity_type, entity_id, urgent, email_due)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.id, n.kind, JSON.stringify(n.params ?? {}), n.entityType ?? null, n.entityId ?? null, !!n.urgent, !!u.email && wantsEmail],
    );
  }
}

/** Active users linked to an employee (the employee's portal account). */
export async function userIdsOfEmployee(db: Db, employeeId: number): Promise<number[]> {
  return (
    await rows(db, `SELECT id FROM users WHERE employee_id = $1 AND deleted_at IS NULL AND status = 'active'`, [employeeId])
  ).map((r) => r.id);
}

/** Managers whose access set contains the hotel. */
export async function managerIdsOfHotel(db: Db, hotelId: number): Promise<number[]> {
  return (
    await rows(
      db,
      `SELECT u.id FROM users u JOIN user_hotel_access a ON a.user_id = u.id
        WHERE a.hotel_id = $1 AND u.role = 'manager' AND u.deleted_at IS NULL AND u.status = 'active'`,
      [hotelId],
    )
  ).map((r) => r.id);
}
