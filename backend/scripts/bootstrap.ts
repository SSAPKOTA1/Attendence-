/* First-time setup for an empty database (production-safe):
 *   npm run bootstrap:prod -- --company "Trip Inn Hotels" --hotel "Trip Inn Frankfurt" --email admin@example.com [--city Frankfurt] [--region DE-HE] [--timezone Europe/Berlin]
 * Creates the company, its first hotel (default settings) and ONE admin in state "invited", and prints a single-use
 * link (valid 7 days) with which the admin chooses their own password. Refuses to run when a company already exists. */
import 'dotenv/config';
import { closePool } from '../src/db/pool';
import { withTransaction } from '../src/db/tx';
import { DEFAULT_SETTINGS } from '../src/domain/settings';
import { INVITE_TTL_MS, createUserToken } from '../src/services/tokens';
import { link } from '../src/services/mailer';
import { audit } from '../src/services/audit';

export interface BootstrapInput {
  company: string;
  hotel: string;
  email: string;
  city?: string;
  region?: string;
  timezone?: string;
}

export async function bootstrap(input: BootstrapInput): Promise<{ companyId: number; hotelId: number; adminId: number; inviteUrl: string; expiresAt: Date }> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw new Error('A valid --email is required');
  if (!input.company.trim() || !input.hotel.trim()) throw new Error('--company and --hotel are required');
  const tz = input.timezone ?? 'Europe/Berlin';
  new Intl.DateTimeFormat('en', { timeZone: tz }); // throws on an unknown time zone
  return withTransaction(async (db) => {
    // serialise concurrent bootstraps
    await db.query('SELECT pg_advisory_xact_lock(4204299)');
    const existing = await db.query('SELECT count(*)::int AS n FROM companies');
    if (existing.rows[0].n > 0) throw new Error('The database already contains a company: bootstrap is only for an empty database');
    const company = (await db.query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [input.company.trim()])).rows[0];
    const hotel = (
      await db.query(
        `INSERT INTO hotels (company_id, name, city, timezone, holiday_region, settings) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [company.id, input.hotel.trim(), input.city ?? null, tz, input.region ?? 'DE-HE', JSON.stringify(DEFAULT_SETTINGS)],
      )
    ).rows[0];
    const admin = (
      await db.query(
        `INSERT INTO users (company_id, email, role, status, first_name) VALUES ($1,$2,'admin','invited','Admin') RETURNING id`,
        [company.id, input.email.trim()],
      )
    ).rows[0];
    const { token, expiresAt } = await createUserToken(db, admin.id, 'invite', INVITE_TTL_MS);
    await audit(db, { userId: admin.id, companyId: company.id, requestId: 'bootstrap' }, { action: 'system.bootstrap', entityType: 'company', entityId: company.id, hotelId: hotel.id });
    return { companyId: company.id, hotelId: hotel.id, adminId: admin.id, inviteUrl: link('accept-invite', token), expiresAt };
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  bootstrap({
    company: arg('company') ?? '',
    hotel: arg('hotel') ?? '',
    email: arg('email') ?? '',
    city: arg('city'),
    region: arg('region'),
    timezone: arg('timezone'),
  })
    .then((r) => {
      console.log(`Created company #${r.companyId}, hotel #${r.hotelId} and admin #${r.adminId}.`);
      console.log(`Give the admin this single-use link (valid until ${r.expiresAt.toISOString()}) to set their password:\n${r.inviteUrl}`);
    })
    .catch((err) => {
      console.error(`bootstrap failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => undefined));
}

