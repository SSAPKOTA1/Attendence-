# Security review of the backend (branch `claude/shift-scheduler-attendance-backend-hdmanm`)

Scope: all of `backend/src`, migrations, scripts and the CI workflow. Method: automated checks (SQL interpolation scan,
`npm audit`, secret scan) plus a manual read of authentication, access control, kiosk, payroll and error handling.

## Checked and found sound
| Area | Result |
|---|---|
| SQL injection | Every query is parameterised. The only interpolated fragments are hard-coded constants (filter clauses, a fixed table map, generated savepoint names). |
| Dependencies | `npm audit`: 0 vulnerabilities. |
| Secrets | None committed; `.env` is git-ignored. |
| Passwords, PINs, tokens | Passwords and PINs bcrypt-hashed; refresh, invite, reset, device and punch tokens stored as SHA-256 hashes, 256-bit random, single use where specified. |
| Sessions | Refresh rotation with reuse detection (revokes the family), httpOnly+Secure+SameSite=Strict cookie, CSRF header + Origin check, revoked sessions invalidate their access tokens immediately, `alg: none` tokens refused. |
| Tenant isolation | Company and hotel scope enforced in every service; foreign ids answer 404 (tested). |
| Mass assignment | zod schemas strip unknown fields; roles, hotel access and company are never taken from the body of a non-admin. |
| Privacy | Audit log is PII-free and append-only (trigger); sick-leave reasons never stored; kiosk exposes display names only; inquiry bodies never copied to audit or e-mail. |
| Errors | No stack traces or SQL; unexpected errors are `INTERNAL_ERROR` with details only in logs. |

## Findings fixed in this change
| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | `NODE_ENV` defaulted to `development`, so a deployment that forgot it would run with the public default JWT secret. | Default is now `production`, which refuses the default secret at boot. Local work sets `NODE_ENV=development` (see `.env.example`). |
| 2 | Medium | A manager who is also an employee could approve their own absence, correction or wish and edit their own time entries. | Four-eyes rule: the request stays pending / is refused (`403`) unless decided by another manager or an admin. |
| 3 | Medium | Rate limits and the kiosk IP allow-list keyed on `req.ip`, but proxy trust was hard-wired to loopback: behind a real proxy all users would share one IP (lock-out of everyone) and the allow-list would see the proxy. | New `TRUST_PROXY` setting (number of hops or `loopback`). **Must be set correctly in production.** |
| 4 | Medium | `POST /kiosk/pair`, `/auth/forgot-password`, `/auth/accept-invite`, `/auth/reset-password` were not rate-limited (pairing-code guessing, mail bombing). | Per-IP limits added. |
| 5 | Low | Duplicate/constraint errors returned database constraint names. | Generic messages only. |
| 6 | Low | `/ready` exposed the names of pending migrations publicly. | Returns only the count. |

## Accepted risks / follow-ups (not changed)
- **Account lock reveals existing accounts** (required by spec test 2): after 10 failures a real account answers `423`, an unknown one keeps answering `401`. Mitigated by the 5-attempts-per-15-minutes limit per IP and login.
- **Rate limiters are in-process**: with several instances the effective limits multiply; use a shared limiter or the reverse proxy.
- **PIN lock-out can be triggered by anyone with a tablet** (5 wrong PINs lock a colleague for 15 minutes). Inherent to PIN-only kiosks; managers can unlock.
- **Buddy punching** on the shared tablet remains the documented residual risk (spec section 9).
- **Reset/invite links are bearer tokens in URLs**; serve the front end with `Referrer-Policy: no-referrer`.
- **Manager-issued reset links** let a manager sign in as a staff member of their hotel. This is spec-mandated (R19) and audited.
- Operational: apply `scripts/db-roles.sql` (no DDL for the app role), HTTPS only, rotate `JWT_SECRET` via deployment secrets, and run the load test and backup/restore drill before go-live.
