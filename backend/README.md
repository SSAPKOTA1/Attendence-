# Shift Scheduler & Attendance – backend

Implementation of [`docs/SPEC.md`](../docs/SPEC.md) v2.4 (all phases 0–10): rostering with draft/publish, split shifts,
floating staff across hotels, youth-protection rules, absences with per-day expansion and vacation allowance,
shared-tablet attendance (PIN + server time), corrections and period lock, time account, payroll export
(generic CSV/JSON and template-driven DATEV LODAS), wishes and planning dashboard, employee portal, notifications,
inquiries, analytics, PII-free audit log, anonymisation and retention jobs.

Design notes and the interpretations of ambiguous spec points are in [`docs/IMPLEMENTATION_PLAN.md`](../docs/IMPLEMENTATION_PLAN.md).

## Stack

TypeScript (Node 20+), Express 5, PostgreSQL 16 with raw SQL via `pg`, `zod`, `luxon`, `date-holidays`,
`node-pg-migrate` (SQL migrations), `pino`, `node-cron`, `vitest` + `supertest` against a real database.

## Getting started

```bash
cd backend
docker compose up -d            # Postgres 16 with databases shiftsched and shiftsched_test
cp .env.example .env            # adjust JWT_SECRET etc.
npm install
npm run migrate                 # applies migrations/0001_init.sql (spec Appendix A) and 0002_runtime.sql
npm run seed                    # demo company, hotels, users, PINs and a kiosk device token (never in production)
npm run dev                     # http://localhost:3000/api/v1, docs at /api/v1/docs
```

## Commands

| Command | Purpose |
|---|---|
| `npm test` | All unit and integration tests (needs `TEST_DATABASE_URL`, default `postgres://postgres:postgres@localhost:5432/shiftsched_test`; the schema is recreated on every run) |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint |
| `npm run build` && `npm start` | Compile to `dist/` and run |
| `npm run migrate` | Forward-only migrations |
| `npx tsx scripts/gen-openapi.ts` | Regenerate `openapi.yaml` from the endpoint catalog |

## Layout

```
migrations/      0001_init.sql (= spec Appendix A, never edited), 0002_runtime.sql (punch tokens, indexes)
src/
  app.ts server.ts config.ts clock.ts logger.ts
  db/            pool (type parsers), tx (transactions, row locks), errorMap (pg error → API error)
  errors/        AppError + catalog (Appendix B, de/en messages)
  middleware/    requestId, auth (JWT + live access set), rateLimit, etag, errorHandler
  domain/        pure rules: hours, instants (DST-safe), restPeriod, minorRules, timeOffDays, vacation,
                 anomalies, timeAccount, supplements, bradford, settings, names, csv
  services/      business logic per area (roster/ evaluate|schedules|bulk|publish, timeOffs, kiosk,
                 attendance, payroll, wishes, portal, inquiries, analytics, retention, ...)
  routes/        thin routers: zod parse → service → respond
  jobs/          needs-review, notification e-mails, token cleanup, inquiry retention, terminated users
scripts/         migrate, seed, gen-openapi, db-roles.sql
tests/           unit/ (domain functions) and integration/ (one file per phase, spec section 10 numbers in test names)
```

## Notes for operators

* `NODE_ENV` defaults to `production` (refuses the built-in dev JWT secret). Use `NODE_ENV=development` locally; set a real `JWT_SECRET` and `TRUST_PROXY` (number of proxy hops) in production. Security review: [`docs/SECURITY_REVIEW.md`](../docs/SECURITY_REVIEW.md).
* All business timestamps come from the server clock (`src/clock.ts`); kiosk requests never carry a time.
* Hotel legal parameters (rest period, daily/weekly limit mode, minors, breaks, retention, DATEV mapping) are hotel
  settings (`PUT /hotels/:id/settings`), not code.
* DATEV export: the templates and wage types must be copied from a sample file accepted by the payroll office
  (open question O16). Until everything needed for a month is mapped the export answers `422 PAYROLL_MAPPING_INCOMPLETE`.
  `tests/fixtures/datev-2026-05.golden.txt` is a hand-written golden file using the illustrative LODAS layout of R21;
  replace it with the office's approved sample when it arrives.
* Least-privilege DB role: `scripts/db-roles.sql`.
* Jobs run in-process with a Postgres advisory lock (safe with several instances); disable with `JOBS_ENABLED=false`.
