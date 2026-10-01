import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const EnvSchema = z.object({
  // default production: a deployment that forgets NODE_ENV must not run with development defaults
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/shiftsched'),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-0123456789abcdef'),
  // number of reverse proxies in front of the app (X-Forwarded-For hops) or 'loopback'; drives req.ip for rate limits and the kiosk IP allow-list
  TRUST_PROXY: z.string().default('loopback'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  REFRESH_ABSOLUTE_DAYS: z.coerce.number().int().positive().default(90),
  APP_URL: z.string().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  MAIL_MODE: z.enum(['console', 'smtp', 'memory', 'disabled']).default('console'),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('no-reply@example.com'),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  LOG_LEVEL: z.string().default('info'),
  JOBS_ENABLED: bool.default(true),
  COOKIE_SECURE: bool.default(true),
  RATE_LIMIT_USER_PER_MIN: z.coerce.number().int().positive().default(100),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  KIOSK_RATE_LIMIT: z.coerce.number().int().positive().default(60),
});

export type Config = z.infer<typeof EnvSchema> & { corsOrigins: string[] };

function load(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast at boot with a readable message.
    throw new Error(`Invalid environment: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_SECRET.startsWith('dev-only')) {
    throw new Error('JWT_SECRET must be set (NODE_ENV defaults to production; set NODE_ENV=development for local work)');
  }
  return {
    ...parsed.data,
    corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

export const config: Config = load();
