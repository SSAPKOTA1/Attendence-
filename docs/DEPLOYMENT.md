# Deployment guide

## 1. What you need
- PostgreSQL 16 (EU region; managed provider with the `btree_gist` extension, backups and point-in-time recovery).
- A container host (or Node 22) behind an HTTPS reverse proxy.
- An SMTP account for invites, resets and notification e-mails (without e-mail, invite links are handed over manually, see R19).

## 2. Configuration (environment variables)
| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production`. The app **defaults to production** and refuses to start with the built-in development secret. |
| `DATABASE_URL` | yes | Use the least-privilege role from `backend/scripts/db-roles.sql` for the running app; run migrations with the owner role. |
| `JWT_SECRET` | yes | At least 32 random characters (`openssl rand -base64 48`). Rotating it signs everyone out. |
| `TRUST_PROXY` | yes | Number of reverse proxies in front of the app (e.g. `1`). Needed for correct client IPs (rate limits, kiosk IP allow-list). `true` is rejected on purpose. |
| `APP_URL` | yes | Public URL of the front end; used in invite and reset links. |
| `CORS_ORIGINS` | yes | Comma-separated allowed browser origins (the front end). |
| `MAIL_MODE`, `SMTP_URL`, `MAIL_FROM` | for e-mail | `MAIL_MODE=smtp` in production. With `console`/`disabled` invite links are returned in API responses. |
| `COOKIE_SECURE` | default `true` | Keep `true` (HTTPS only). |
| `JOBS_ENABLED` | default `true` | Background jobs take a Postgres advisory lock, so several instances are safe. |
| `PORT`, `LOG_LEVEL`, `BCRYPT_COST` | optional | Defaults 3000 / info / 12. |

## 3. First deployment
```bash
docker build -t shiftsched ./backend
docker run --rm --env-file prod.env shiftsched npm run migrate:prod        # forward-only migrations
docker run --rm --env-file prod.env shiftsched npm run bootstrap:prod -- \
  --company "Trip Inn Hotels" --hotel "Trip Inn Frankfurt" --email owner@example.com --city Frankfurt
docker run -d --env-file prod.env -p 3000:3000 shiftsched
```
`bootstrap:prod` works on an empty database only. It prints a single-use link (7 days) for the first admin to choose their
own password. Everything else (more hotels, departments, shifts, employees, users, kiosk tablets) is done through the API
or the admin UI.

Then, as the admin:
1. Hotel settings (`PUT /hotels/:id/settings`): legal parameters, payroll (consultant/client number, wage types incl. `publicHoliday`, `saturday`; the LODAS layout is pre-filled).
2. Create departments and design the shift templates (admin only).
3. Add employees (admin only) with pay type and public-holiday setting, then invite their logins and reset PINs for the tablet.
4. Pair the shared tablet (`POST /kiosk/pairing-codes`, enter the code on the tablet).

## 4. Reverse proxy checklist
- Terminate TLS; forward `X-Forwarded-For`; set `TRUST_PROXY` to the number of hops.
- Add gzip/brotli compression (roster responses can be large) and `Referrer-Policy: no-referrer` for the front end (links contain tokens).
- Do not cache `/api/v1` responses.
- Rate limits are per application instance: add proxy-level limits if you run several instances.

## 5. Operations
- `GET /api/v1/health` (liveness) and `/api/v1/ready` (database reachable, migrations applied).
- Logs are JSON (pino) with `requestId`; secrets and tokens are redacted.
- Backups: daily + point-in-time recovery; **test a restore before go-live**.
- Upgrades: build the new image, run `migrate:prod`, then roll the containers. Migrations are forward-only; never edit an applied one.
- Load test: `npm run loadtest` (throw-away database). Reference result on a 4-core machine with 150 employees and 3,300 roster entries: employee list 37 ms, roster month 225 ms, payroll export 2.7 s, 89 req/s mixed workload with p95 608 ms (load generator and server on one process).
- Security review and accepted risks: `docs/SECURITY_REVIEW.md`.
