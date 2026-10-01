# Implementation plan: backend v2.4 in one pass

The spec (`docs/SPEC.md`) recommends building phase by phase. This build delivers Phases 0–10 together, but keeps the
phase structure internally: infrastructure first, then each domain on top of the previous one, and an integration test
file per phase that maps 1:1 to the scenario numbers in spec Section 10.

## 1. Analysis summary

| Area | Size | Main risks | Mitigation |
|---|---|---|---|
| Infrastructure (config, pool, errors, i18n, audit, mail, rate limits) | M | DB errors leaking; inconsistent error envelope | One `AppError` + catalog (Appendix B), central `errorMap` for pg codes, one error middleware |
| Auth & users (A1–A11, U1–U7) | L | refresh rotation/reuse, CSRF, cookie flags, enumeration | Token families in `refresh_tokens`, reuse ⇒ revoke family; CSRF check on cookie-based refresh/logout; uniform responses |
| Access model (staff / hotel manager / regional / admin) | M | 404 vs 403 semantics, floating staff reduced view | One `access` module: `resolveHotelId`, `loadEmployeeAccess` (visible / home-manager), used by every service |
| Roster (C1–C12, E8) | XL | overlaps across midnight/hotels/DST, split shifts, minors, concurrency | Pure domain functions (`instants`, `restPeriod`, `minorRules`, `warnings`) + `ScheduleService.evaluate()` shared by create/patch/validate/bulk/copy/candidates; employee row lock (`FOR UPDATE`) + DB trigger as final guard |
| Absences & allowance (T0–T5, E9/E10, B1–B3) | L | counted days, holidays of home hotel, cross-year usage, sick-in-vacation | `domain/timeOffDays` + `date-holidays`; usage only from `v_vacation_usage` |
| Attendance & kiosk (K1–K7, P1–P3, AT1–AT11, E13) | XL | server time only, anomalies, locks, DST, payroll/DATEV | App clock (`clock.ts`, injectable for tests) used for every timestamp; corrections as rows; period lock check in one helper; DATEV purely template-driven |
| Wishes, portal, notifications, inquiries | L | privacy (plan visibility, names), routing | Name formatting helper; routing derived from related entity |
| Analytics, audit, retention, anonymisation | M | PII in audit, aggregation semantics | `AuditService` strips PII keys recursively; analytics return aggregates only |

## 2. Interpretations of open points (documented, not silently decided)

| Topic | Interpretation |
|---|---|
| Login rate limit (5/15 min per IP+login) vs. lock after 10 failures (test 2) | Both implemented; limits are configurable (`LOGIN_RATE_LIMIT`), tests raise the IP limit so the account lock can be observed |
| Manager-created absences | `status` may be sent (`pending`/`approved`); default `approved` for managers, `pending` for staff |
| R6 conflict check | Applied when the absence becomes `approved` (create-approved or approve). Pending requests return the conflicting ids for information. `sick_leave` never fails: it returns `conflicts` |
| An absence "covers" a date | Any date in `[startDate, endDate]` (not only counted days) |
| Remaining vacation vs pending requests | `ALLOWANCE_EXCEEDED` if new days > `remainingDays − pendingDays` |
| `DELETE /time-offs/:id` | Cancels (status `cancelled`) and returns 204; history stays |
| Unassigning a hotel | `unassigned_on = today` (entries after today blocked by the DB trigger) |
| Work-summary week status | `over_max` > max; `above` > target; `below` < target; else `on_target` (scheduled + credited) |
| Sick credit limit | First `sickCreditMaxDays` calendar days of each sick-leave spell |
| Shift-wish errors | past date ⇒ `422 SCHEDULE_DATE_IN_PAST`; existing roster entry ⇒ `409 EMPLOYEE_ALREADY_SCHEDULED`; approved absence ⇒ `422 EMPLOYEE_ON_TIME_OFF`; duplicate pending ⇒ `409 DUPLICATE_RESOURCE` |
| Manager moving lock backward | `403 FORBIDDEN` |
| Supplements (night/Sunday/holiday minutes) | Computed on clock-in → clock-out of closed entries at the hotel, split by hotel-local minute |
| DATEV golden file | No sample from the payroll office exists yet (O16). The golden-file test uses the illustrative layout from R21; replace templates + golden file once the office supplies its accepted sample |
| Punch tokens | Stored hashed in a small table added by migration `0002_runtime` (single use, 60 s) so it works with several app instances |
| Access set freshness | The JWT carries `role/companyId/hotelIds/employeeId`; the auth middleware re-reads the user's access set per request so disabled users and access changes apply immediately |

## 3. Architecture

```
backend/src
  app.ts / server.ts / config.ts / clock.ts / logger.ts
  db/          pool (type parsers), tx (withTransaction), errorMap
  errors/      AppError, catalog (HTTP status + de/en messages)
  middleware/  requestId, auth, deviceAuth, requireRole, validate, rateLimit, errorHandler, etag
  domain/      hours, instants, restPeriod, weeks, timeOffDays, vacation, minorRules, anomalies, timeAccount, bradford, names, csv
  services/    one per business area (Auth, Session, User, Org, Settings, Department, Shift, Employee, Holiday, TimeOff,
               Allowance, Blackout, Schedule, Bulk/Copy/Publish, Candidate, Coverage, WorkSummary, Kiosk, Pin, Attendance,
               TimeAccount, PayrollExport, Wish, Planning, Portal, Notification, Inquiry, Analytics, Audit, Retention, Mailer)
  repositories/ SQL + snake↔camel mapping per aggregate
  routes/      thin routers: zod-parse → service → respond
  jobs/        needsReview, notificationMailer, tokenCleanup, inquiryRetention, disableTerminatedUsers (advisory lock)
```

Testing: `vitest` + `supertest` against a real PostgreSQL 16 database. Global setup recreates the schema and runs the
migrations; each test file truncates all tables. A fixed application clock (`2026-10-01T06:00:00Z`) makes "today",
DST nights and kiosk timestamps deterministic. Unit tests cover the pure domain functions.

## 4. Build order

1. Phase 0: project skeleton, config, pool, migrations runner, errors, logging, health/ready, test harness, seed skeleton.
2. Phase 1: auth + sessions + users + companies/hotels/settings + access middleware + rate limits + mailer + audit.
3. Phase 2–3: departments, shifts, staffing requirements, employees, hotel assignment, targets, holidays.
4. Phase 4: absences, preview, allowance, blackouts.
5. Phase 5: roster engine (evaluate → create/patch/validate/bulk/copy/publish/unpublish/candidates/coverage/work summary).
6. Phase 6: kiosk, PINs, attendance, corrections, locks, live board, jobs, time account, exports (CSV/JSON/DATEV).
7. Phase 7–8: wishes, planning dashboard, portal, notifications (+ e-mail job), inquiries.
8. Phase 9–10: analytics, audit endpoint, anonymisation, retention jobs.
9. OpenAPI document, seed script, README, CI workflow.
10. Compile (`tsc --noEmit`), run the full test suite, fix until green.

## 5. Test map (spec Section 10)

| File | Scenarios |
|---|---|
| `tests/integration/phase1.auth.test.ts` | 1–7, 95–99 |
| `tests/integration/phase2.structure.test.ts` | 8–11 |
| `tests/integration/phase3.employees.test.ts` | 12, 71, 93 |
| `tests/integration/phase4.timeoffs.test.ts` | 13–22, 94, 113, 115 |
| `tests/integration/phase5.roster.test.ts` | 23–40, 66–70, 72, 76–92, 111, 117 |
| `tests/integration/phase6.attendance.test.ts` | 41–56, 73, 74, 106, 112, 116 |
| `tests/integration/phase7.wishes.test.ts` | 57–60, 114 |
| `tests/integration/phase8.portal.test.ts` | 100–105, 107–110 |
| `tests/integration/phase9.analytics.test.ts` | 61–63, 75 |
| `tests/integration/phase10.retention.test.ts` | 64–65 |
| `tests/unit/*.test.ts` | hours, instants/rest period (DST), weeks, counted days, vacation, minors, anomalies, Bradford, time account |

## 6. Result (this build)

| Check | Result |
|---|---|
| `npm run lint` / `npm run typecheck` / `npm run build` | clean |
| `npm test` | 12 files, 283 tests passing: every scenario 1–117 of spec Section 10 (test names carry the number), 25 domain unit tests, and a route-coverage test proving all 121 operations of the Section 8 catalog are routed |
| Migrations | `0001_init` (Appendix A verbatim) + `0002_runtime` (punch tokens, two indexes) apply on PostgreSQL 16 |
| Smoke test | compiled server boots, `/ready` reports migrations, seed data usable, `/api/v1/docs` served |

Known limits / follow-ups:
- The DATEV golden file is hand-written from the illustrative LODAS layout in R21; replace templates and golden file with the payroll office's approved sample (O16).
- R19 "suggested username" is left to the client (the API accepts any valid username and reports collisions as `409 DUPLICATE_RESOURCE`).
- Rate limiting is in-process (per instance); put a shared limiter (e.g. Redis or the reverse proxy) in front when running several instances.
- Night/Sunday/holiday minutes are computed on clock-in → clock-out; whether breaks reduce supplements depends on the collective agreement (confirm with payroll).
- Load test, security review and backup/restore drill from Phase 10 are operational tasks outside the code base.
