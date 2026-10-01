import { createHash } from 'node:crypto';
import { Db } from '../db/pool';
import type { AuthContext } from '../types/context';

/** Keys never written to audit_logs (R14: the audit trail is PII-free). Compared case-insensitively, ignoring _ . */
const PII_KEYS = new Set(
  [
    'firstName', 'lastName', 'name', 'email', 'phone', 'hourlyRate', 'password', 'passwordHash', 'newPassword',
    'currentPassword', 'pin', 'newPin', 'pinHash', 'birthDate', 'username', 'login', 'body', 'subject', 'reason',
    'note', 'decisionNote', 'token', 'tokenHash', 'refreshToken', 'accessToken', 'address', 'userAgent', 'ip',
    'employeeNumber', 'displayName',
  ].map((k) => k.toLowerCase()),
);

function isPiiKey(key: string): boolean {
  return PII_KEYS.has(key.replace(/_/g, '').toLowerCase());
}

export function stripPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPii);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isPiiKey(k)) continue;
      out[k] = stripPii(v);
    }
    return out;
  }
  return value;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: number | null;
  hotelId?: number | null;
  companyId?: number | null;
  userId?: number | null;
  before?: unknown;
  after?: unknown;
  /** meta may carry overrideReason / reason of overrides explicitly (allowed by the spec); everything else is stripped */
  meta?: Record<string, unknown>;
}

const META_ALLOWED_TEXT = new Set(['overrideReason', 'adminReason', 'forceReason']);

export async function audit(db: Db, ctx: Pick<AuthContext, 'userId' | 'companyId' | 'requestId'> | null, e: AuditEntry): Promise<void> {
  const meta: Record<string, unknown> = { requestId: ctx?.requestId };
  for (const [k, v] of Object.entries(e.meta ?? {})) {
    meta[k] = META_ALLOWED_TEXT.has(k) ? v : stripPii(v);
    if (!META_ALLOWED_TEXT.has(k) && isPiiKey(k)) delete meta[k];
  }
  await db.query(
    `INSERT INTO audit_logs (company_id, hotel_id, user_id, action, entity_type, entity_id, before, after, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      e.companyId ?? ctx?.companyId ?? null,
      e.hotelId ?? null,
      e.userId ?? ctx?.userId ?? null,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.before === undefined ? null : JSON.stringify(stripPii(e.before)),
      e.after === undefined ? null : JSON.stringify(stripPii(e.after)),
      JSON.stringify(meta),
    ],
  );
}
