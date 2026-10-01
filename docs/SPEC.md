# Shift Scheduler & Attendance: Backend Specification v2.4

**Status:** implementation-ready for Phase 0. Supersedes v2.3, v2.2, v2.1, v2 and v1.
**Product:** Gastromatic-style rostering **and attendance** for hotels (Trip Inn Hotels, Frankfurt first).
**Scope:** backend API + database. Frontend spec is separate.

The SQL in Appendix A was executed on PostgreSQL 16 and checked by a self-checking suite of 113 checks (split shifts and overlaps across midnight and hotels, floating-staff assignment, overlapping absences, sick-during-vacation, school days, day-off exclusivity, publish state, overlapping/open time entries, breaks, corrections, accounts with and without e-mail, inquiries, notifications, multi-hotel access, anonymisation, audit immutability), all passing. The API behaviour, services and tests described below are still **paper**: they become real phase by phase, and Section 10 is how you prove each one.

---

## 0. How to use this with Claude Code

1. Create the repo and save this file as `docs/SPEC.md`.
2. Add a `CLAUDE.md` in the repo root: *"`docs/SPEC.md` is the single source of truth for names, endpoints, rules and error codes. Read the relevant sections before writing code. Never rename fields. Write the phase's tests first, then the code. Run `npm test` after every phase."*
3. Build **one phase at a time** (Section 13), in order. A phase is done only when its tests pass.
4. Names live in this spec and in the schema, not in chat memory. Claude Code reads your repo, not this conversation.

---

## 1. What changed, and why

### 1.1 Audit findings from v2 and their fixes
| Finding | Fix in v2.1 |
|---|---|
| Sick during vacation was rejected; weekly rest day inside vacation rejected; a pending request blocked unrelated ones | Sick leave may overlap other absences (own exclusion constraint). Planned days off ("Frei") are now **roster entries** (`entry_type = off`), not absences |
| `timeOffDays` supplied by client, no holiday/working-day logic, cross-year hack | Server expands every absence into per-day rows (`time_off_dates`), skipping non-working weekdays and public holidays; cross-year works naturally; `POST /time-offs/preview` shows the result before saving |
| Credited hours assumed Mon–Fri | Credit per day = `targetHoursPerWeek / number of employee work weekdays` |
| No attendance (clock in/out) | Shared hotel tablet + PIN, server time only, corrections history, period lock, time account (Section R13) |
| Rest-period maths wrong on clock-change nights | Instants computed from local date + time per shift, not `start + duration` (R4) |
| Audit log (append-only) held personal data, so erasure was impossible | Audit stores IDs and non-personal fields only; employees can be **anonymised** while history stays (R14) |
| No draft/publish; staff saw unfinished rosters | `schedules.status` draft → published; staff/kiosk see published only (R12) |
| One copy/assign request per calendar cell | `POST /schedules/bulk` and `/schedules/copy` |
| No invite/password-reset, yet staff need logins | Invite, accept, forgot, reset flows (A6–A8, U5) |
| Manager bound to a single hotel | `user_hotel_access`: hotel manager = 1 hotel, regional manager = several, admin = all (D13) |
| Legal rules hard-coded while German law is changing | Legal parameters in hotel `settings` (daily vs weekly limit mode, sick-note day, retention) (Section 4) |
| Inconsistencies (D3 wording, `EMPLOYEE_INACTIVE`, `unassignConflicts`) | Corrected |

### 1.2 Your decisions (confirmed)
Clock-in on a **shared hotel tablet** with **name + PIN only**; **automatic deduction** of the scheduled break; **both** hotel managers and regional managers; rosters are **draft until published**; **some staff float between hotels**; split shifts are **rare** (supported, default max 2 per day); **minors and apprentices are employed**; **most staff have an e-mail address, some do not**; employees get a **browser portal** (plan, hours, vacation, wishes, questions); **minors' protection rules warn** (the manager decides, a written reason is required); staff see the plan of their **own departments**; the payroll export uses the **DATEV Lohn** format.

### 1.3 What floating staff changed (v2.2)
| Area | Rule |
|---|---|
| Employee | Belongs to the **company**; assigned to one or more hotels (`employee_hotels`, exactly one home hotel) |
| Follows the person (valid at every hotel) | master data, hourly rate, work targets and time account, vacation allowance, absences and certificates, PIN, leave wishes, work weekdays |
| Tied to a hotel | departments, shifts, roster entries, shift wishes, time entries, corrections, staffing requirements |
| Enforced across hotels | one roster entry per employee per day; no overlapping time entries; weekly/monthly totals, limits and rest periods count **all** hotels |
| Who decides | the **home hotel's** manager edits master data and decides absences and leave wishes; a manager of any assigned hotel can roster the employee |
| Unassigning | sets `unassigned_on`; history stays; new entries after that date are blocked by the database |

### 1.4 Defaults I applied (tell me if wrong, see Section 15)
3-year time-record retention, 24-month inquiry retention, 42-day sick-credit limit, German + English UI, the DATEV payroll product still to be confirmed by the payroll office (open question O16), TypeScript + raw SQL.

### 1.5 What changed in v2.3
| Topic | Change |
|---|---|
| Employee portal | Browser login for employees: dashboard, hotel plan, own hours and time account, vacation balance, wishes and requests, questions to managers, notifications, profile (R15–R17) |
| Split shifts | Several shifts per day allowed (default max 2) as long as they do not overlap; a day off excludes everything else; overlaps are checked across hotels by the database (R2, R4) |
| Minors and apprentices | Birth date, employment type, `school` absence type, youth-protection rules (R18) |
| Accounts without e-mail | Username login, hand-over link, manager-issued reset link (R19) |
| Browser security | Refresh token in an httpOnly cookie, CSRF protection, session list and revocation |
| Operations | Cover finder (R20), payroll export (R21), leave blackout periods and wish lead time (R22) |
| Fixes | Holiday region of a floating employee = home hotel; staff can read their own work summary and wish lists; terminated employees lose login and PIN |

### 1.6 What changed in v2.4
| Topic | Change |
|---|---|
| Minors' rules | Default enforcement is now **`warn`** (manager decides). Saving an entry with a minor-protection warning **requires a written `overrideReason`** (`requireOverrideReason`, default on; error `OVERRIDE_REASON_REQUIRED`), recorded in the audit log. `block` remains available per hotel |
| Plan visibility | Confirmed: staff see the plan of their own departments (at every hotel they are assigned to) |
| Payroll | DATEV Lohn export (`format=datev`), template-driven from the payroll office's official sample, refuses to run until the mapping is complete (R21) |

### 1.7 What changed after v2.4 (owner decisions)
| Topic | Change |
|---|---|
| Payroll product | **LODAS** confirmed. `payroll.datev.product` defaults to `lodas` and the LODAS templates are pre-filled; only consultant/client numbers and wage types remain to be entered (still verify against the payroll office's sample) |
| Supplements | New **Saturday** supplement (`saturdayMinutes`, wage type `saturday`). The unpaid break is **deducted automatically** from night, Saturday, Sunday and holiday minutes, proportionally (worked ÷ gross) because the break time of day is not recorded |
| Shift design | Shift templates are designed in the app (`POST/PATCH/DELETE /shifts`) by **admins only** (1.9); managers read them and assign them in the roster; the seed shifts are examples only |

### 1.12 Unplanned clock-in: reason and supervisor approval (owner decision)
| Topic | Rule |
|---|---|
| What is "unplanned" | A kiosk `clock_in` for which there is no published, not yet used shift **at this hotel** whose window contains now (R13.5): no shift, a shift only at another hotel, outside the 2 h early window, or during an approved absence |
| Reason | `POST /kiosk/punch` with `action: clock_in` must carry `reason` (3–500 characters) when unplanned, else `422 UNPLANNED_REASON_REQUIRED`. The refused punch does **not** burn the punch token (the tablet asks for the reason and retries within the 60 s). `POST /kiosk/verify` answers `reasonRequiredForClockIn` so the tablet can ask first. A reason sent for a planned shift is ignored |
| Approval state | `time_entries.approval_status`: `not_required` (planned shifts, manager-created entries), `pending` (unplanned, from clock-in), `approved`, `rejected`. Fields: `unplannedReason`, `approvedById`, `approvedAt`, `approvalNote` |
| Hours | Only `closed` entries that are `not_required` or `approved` count as worked hours: time account, work hours on the dashboard, payroll/DATEV, analytics hours. **Pending** entries show in `payroll-export` as `unapprovedEntries` (JSON warning `entries_pending_approval`, header `X-Warnings`) and in analytics as `entriesAwaitingApproval`, because a decision is still due. **Rejected** entries are final: they contribute no hours anywhere (their `workedMinutes` is reported as `0`, also in the attendance export), are not an open item and raise no warning; only their anomalies still count in analytics |
| Decision | `PATCH /attendance/:id/approval { status: approved | rejected, note }` (AT12): managers of the entry's hotel and admins. The entry must be closed (a forgotten clock-out is first closed by a correction). Rejection needs a note. Decisions can be revised (approved ⇄ rejected). Nobody decides their own hours except an admin. The payroll period lock applies (`423 PERIOD_LOCKED`, admin with a note overrides, audited) |
| Notifications | `time_approval_requested` to the hotel's managers when the hours become final (clock-out); `time_approval_decided` to the employee (ids only, never the note); live board `awaitingApproval` |


### 1.14 Vacation at onboarding and automatic carry-over (owner decision)
- **Onboarding:** `POST /employees` accepts `vacation: { year?, vacationDaysPerYear, carriedOverDays (left from last year), remainingThisYearDays (left of this year's own entitlement), carryOverExpiresOn? }`. The days already taken before the employee entered the system are stored as `alreadyTakenDays = vacationDaysPerYear − remainingThisYearDays` and count as used (carry-over is consumed first). `remainingDays = vacationDaysPerYear + carriedOverDays − usedDays`.
- **Automatic carry-over:** a later year's allowance is created from the previous year: same `vacationDaysPerYear`, `carriedOverDays` = what is left of the previous year (never negative, capped by hotel setting `absence.maxCarryOverDays`, default no cap), expiring on `absence.carryOverExpiresOn` (`MM-DD`, default `03-31`, `null` = never). It is recalculated on every read, so later approvals or cancellations in the previous year change it. Unused carry-over lapses after the expiry date (R9).
- **Manual override:** `PUT /employees/:id/vacation-allowance` with a number in `carriedOverDays` fixes it by hand; `null` returns to automatic; `alreadyTakenDays` is writable. Allowance responses add `carryOverAutomatic` and `alreadyTakenDays`. Migration `0006`.

### 1.13 Forgotten clock-out on a planned shift (owner decision)
If an employee forgets to clock out of a **planned** shift, the hourly job closes the entry once `attendance.autoCloseAfterPlannedEndHours` (default 5, `null` = off) have passed after the planned shift end: `clockOutAt` = planned end, `breakMinutes` = the shift's scheduled break (capped below the gross time), `sourceOut` = `system`, anomaly `auto_closed_planned_hours`, managers are notified (`needs_review_entry`, `anomaly: auto_closed`) and the audit log records `attendance.auto_close`. The credited hours run from the real clock-in to the planned end. Not auto-closed: unplanned entries (no planned hours exist; they become `needs_review` after `needsReviewAfterHours`), entries clocked in after the planned end, and entries whose day is in a locked period. A manager can still correct the entry (AT corrections). This replaces the "never auto-closed" part of R13.7 for planned shifts.

### 1.11 Data-integrity rules found by the audit
| Rule | Behaviour |
|---|---|
| Shift in use | Start time, end time, break and department of a shift that any roster entry references can no longer be changed (`409 RESOURCE_IN_USE`); only the name can. Create a new shift for different times. This keeps rosters, rest-period checks and past payroll months stable |
| Departments of an employee | Cannot be removed while the employee has future roster entries on shifts of that department (`409 RESOURCE_IN_USE`) |
| Termination | Setting an employee `terminated` is refused while roster entries after the termination date exist; `removeFutureEntries: true` deletes them (audited). The entries on the termination date itself stay |
| Paid public holidays | Credited only between `hiredOn` and `terminatedOn` |
| Anonymisation | Also deletes the employee's inquiries (free text may contain personal data) |
| Daylight saving | A local time that occurs twice (02:00–02:59 on the autumn change) means the later occurrence, exactly as in PostgreSQL's `AT TIME ZONE`, so the service and the database trigger always agree |

### 1.10 Adding and deleting employees: admin only
Creating (`E3`) and deleting (`E5`) employees is restricted to admins (`403 FORBIDDEN` for managers). Managers of the home hotel still edit master data, targets, hotel assignments, PINs and absences.

### 1.9 Shift templates: admin only
Creating, editing and deleting shift templates (`S2`–`S4`) is restricted to admins (`403 FORBIDDEN` for managers). Managers still read shifts, set staffing requirements and roster employees onto shifts.

### 1.8 Salaried vs hourly, public holidays per employee (owner decisions)
| Topic | Rule |
|---|---|
| `payType` (`salary` \| `hourly`) | **Required when an employee is created**, editable by home-hotel managers. Only `salary` employees have a time account (Arbeitszeitkonto: target, monthly delta, balance). For `hourly` employees `GET /employees/:id/time-account` returns worked/credited hours with `targetHours`, `deltaHours`, `balanceHours` = `null` (`timeAccountEnabled: false`); payroll `timeAccountDeltaMinutes` is `null` |
| `publicHolidaysOff` (boolean, default `true`) | `true`: public holidays of the home hotel region on a work weekday are paid days off: they are skipped when counting absence days, credited like a normal working day (`type: public_holiday`, payroll column `creditedPublicHolidayMinutes`, DATEV wage type `publicHoliday`), and rostering a shift on that day gives the warning `public_holiday_off`. If the employee works that day (roster shift or time entry) there is no holiday credit; the worked time gets the holiday supplement. `false`: holidays are normal working days (counted in absences, no credit, no warning) |

---

## 2. Decisions

| # | Decision |
|---|---|
| D1 | Hierarchy Company → Hotel → Department → Shift. Employees belong to the **company**, are assigned to one or more hotels (exactly one home hotel) and to departments of those hotels. Integrity by composite FKs (`(id, hotel_id)`, `(id, company_id)`, `employee_hotels`) |
| D2 | Paid hours = shift duration − unpaid break; all targets/limits use paid hours (minutes internally) |
| D3 | **Hard blocks** on roster entries: no overlapping shifts for one employee **across all hotels** (split shifts allowed, default max 2 per day); a day off excludes any other entry that day; approved absence covers the date; employee not in the shift's department; employee not assigned to the hotel; date in the past (hotel time); employee terminated; missing/other-company reference; invalid entry shape |
| D4 | **Soft warnings** never block (rest period, limits, wishes, short notice). Stored on the entry; manager may add `overrideReason`; audited |
| D5 | `time_offs` = annual leave, sick leave, unpaid leave, school, other. Planned days off = roster entries of type `off` (0 hours) |
| D6 | Every absence is expanded to counted days by the server (`time_off_dates`); vacation used is **derived** from them, never stored as a counter |
| D7 | Soft delete for master data; employees can be anonymised after retention |
| D8 | Append-only, PII-free `audit_logs` |
| D9 | Sick-leave **reason is never stored** (GDPR Art. 9); DB CHECK enforces it |
| D10 | API under `/api/v1` |
| D11 | Roster lifecycle draft → published; staff and kiosk see published only |
| D12 | Attendance on a **shared tablet**, employee name + PIN, **server time only**, raw timestamps never rounded or overwritten; changes only through correction rows |
| D13 | Access: `staff` → the hotels they are assigned to, via their employee; `manager` → hotels in `user_hotel_access` (1 = hotel manager, several = regional manager); `admin` → whole company |
| D14 | Anomalies and warnings inform, they never block a legitimate punch or roster entry |
| D15 | Legal parameters are per-hotel configuration, not code constants (law is in flux) |
| D16 | Floating staff: facts that follow the person live on the employee, facts tied to a place live on a hotel (see 1.3); rules that must hold across hotels are enforced across hotels |
| D17 | Employee portal: browser login for employees; staff see only their own data plus the published plan per `portal.planVisibility`; questions go to the managers of the routed hotel |
| D18 | Minors (under 18 on the entry date) get dedicated protection checks (R18): default **warn** with a mandatory written override reason; hotels can switch to **block** |
| D19 | A login is an e-mail **or** a username; passwords are only ever set by the person themselves (invite/reset links, no temporary passwords) |

---

## 3. Stack and standards (defaults)

| Concern | Choice |
|---|---|
| Language / framework | TypeScript (Node 20+), Express |
| DB access | `pg`, parameterized raw SQL, repository layer (no ORM) |
| Migrations | `node-pg-migrate`; `0001_init` = Appendix A; never edit an applied migration |
| Validation | `zod` per endpoint |
| Auth | Access JWT (15 min, kept in browser memory only) + rotating opaque refresh token (httpOnly cookie for browsers, body for other clients); kiosk devices use a separate device token |
| Passwords / PINs | bcrypt cost 12; password min 10 chars; PIN 6 digits, server-generated |
| Dates/time | `luxon`; public holidays via `date-holidays` (`hotels.holiday_region`, default `DE-HE`) |
| Mail | `nodemailer` behind a `Mailer` interface; dev mode logs to console |
| Languages | German (default) and English; stable error `code`s, messages by `Accept-Language`; notification texts are keys + params rendered by the client |
| Jobs | `node-cron` with a Postgres advisory lock (one runner at a time): hourly `needs_review` marking, per-minute notification e-mails, daily token cleanup, inquiry retention and disabling of terminated users |
| Logging | `pino` JSON with `requestId` |
| Tests | `vitest` + `supertest` against a real Postgres test DB |
| Local dev | `docker-compose.yml` (Postgres 16) |
| API docs | `openapi.yaml` in repo, served at `/api/v1/docs` |
| Config | `.env` validated by zod at boot |

---

## 4. API conventions and hotel settings

- **Base URL** `/api/v1`, JSON only. `Authorization: Bearer <accessToken>`; kiosk endpoints use `X-Device-Token: <token>`.
- **Naming:** JSON camelCase, DB snake_case; mapping only in repositories. IDs are numbers.
- **Dates** `YYYY-MM-DD` (hotel-local), times `HH:mm`, timestamps ISO-8601 UTC.
- **Lists:** `?page=1&limit=50` (max 100) → `{ "data": [...], "meta": { "page", "limit", "total" } }`. Calendar endpoints (`/schedules`, `/time-offs`, `/attendance`) are range-based (max 62 days, else `422 RANGE_TOO_LARGE`). Single resources are returned unwrapped.
- **Status codes:** 200, 201 (+`Location`), 204; 400 validation, 401, 403, 404 (also for other tenants' data), 409 conflict, 412 stale write, 422 business rule, 423 locked, 429. `DELETE /schedules/:id` returns `200` with `{ id, warnings }` (short-notice warning on published entries); other deletes return 204.
- **Error envelope (always):**
```json
{ "error": { "code": "EMPLOYEE_ON_TIME_OFF", "message": "...", "details": [ { "field": "date", "issue": "..." } ], "requestId": "9f1c..." } }
```
- **Hotel scope:** the JWT carries `role`, `companyId`, `hotelIds` (manager: their access set, admin: all, staff: hotels the employee is assigned to) and `employeeId` (staff). Hotel-scoped endpoints (roster, shifts, departments, attendance, kiosk) take `hotelId` (query or body); it is **required when the caller can access more than one hotel**, defaults to the only hotel otherwise, and must be in the access set (else 404). Employee-scoped endpoints (`/employees/:id/...`, `/time-offs/:id`) need no `hotelId`: access follows the employee's assignments (Section 7). Changing a user's hotel access revokes their refresh tokens so it applies immediately.
- **Optimistic concurrency:** `GET` returns `ETag: W/"<updatedAt ms>"`; `PATCH` of schedules, time-offs, time entries and corrections accepts `If-Match`; mismatch → `412 PRECONDITION_FAILED`. Without the header the last write wins.
- **Transactions & locking:** `POST/PATCH /schedules`, bulk, copy and publish run in one transaction that locks the affected employee rows (`SELECT … FOR UPDATE`, ordered by id to avoid deadlocks). DB constraints are the final guard; violations are mapped to API error codes (Appendix B), never leaked.
- **Staff alias:** `me` may replace `:employeeId` (`/employees/me/...`).
- **Browser sessions:** with header `X-Client: web` the refresh token travels only as cookie `refresh_token` (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`); the access token is kept in memory, never in localStorage. Refresh and logout from a browser must send `X-Requested-With: XMLHttpRequest` and an allowed `Origin` (else `403 CSRF_REJECTED`). CORS uses an allow-list with credentials. One login = one token family; reuse of a rotated token revokes the family.
- **Localisation:** user language `de`/`en` (`users.preferred_language`, `Accept-Language` as fallback); `error.code` is stable, `error.message` is localised.
- **Rate limits:** 100 req/min per user; login 5 attempts/15 min per IP+email, account lock after 10 failures (15 min); kiosk 60 req/min per device; 20 new inquiries per employee per day.

**Hotel `settings` (JSON, defaults; read by managers, written by admin):**
```json
{
  "legal":      { "restPeriodMinHours": 11, "limitMode": "daily", "dailyMaxHours": 10, "weeklyMaxHours": 48,
                  "breakRules": [ { "grossOverHours": 6, "minMinutes": 30 }, { "grossOverHours": 9, "minMinutes": 45 } ],
                  "minors": { "enforcement": "warn", "requireOverrideReason": true, "maxDailyHours": 8, "maxWeeklyHours": 40, "maxDaysPerWeek": 5,
                              "maxShiftSpanHours": 11, "minRestHours": 12, "earliestStart": "06:00", "latestEnd": "20:00",
                              "latestEndHospitality16Plus": "22:00",
                              "breakRules": [ { "workingOverHours": 4.5, "minMinutes": 30 }, { "workingOverHours": 6, "minMinutes": 60 } ] } },
  "roster":     { "changeNoticeHours": 72, "belowTargetOnAssign": false, "maxShiftsPerDay": 2, "maxDaySpanHours": 12 },
  "portal":     { "planVisibility": "own_departments", "nameFormat": "first_last_initial" },
  "wishes":     { "minLeadDays": null },
  "attendance": { "breakMode": "auto", "earlyClockInMinutes": 30, "lateToleranceMinutes": 5,
                  "overtimeToleranceMinutes": 15, "needsReviewAfterHours": 14, "autoCloseAfterPlannedEndHours": 5,
                  "kioskAllowedIps": [], "pinMaxAttempts": 5, "pinLockMinutes": 15 },
  "absence":    { "sickNoteRequiredFromDay": 4, "sickCreditMaxDays": 42 },
  "payroll":    { "nightFrom": "23:00", "nightTo": "06:00",
                  "datev": { "product": "lodas", "consultantNumber": null, "clientNumber": null, "encoding": "windows-1252",
                             "headerTemplate": "<LODAS [Allgemein] block>", "recordDescriptionTemplate": "<LODAS [Satzbeschreibung] + [Bewegungsdaten]>", "lineTemplate": "10;{pnr};{date};{value};{key};{wageType};;;\"{note}\";",
                             "wageTypes": { "worked": null, "annualLeave": null, "sick": null, "school": null,
                                            "night": null, "saturday": null, "sunday": null, "holiday": null } } },
  "retention":  { "timeRecordsYears": 3, "inquiriesMonths": 24 }
}
```
`portal.planVisibility`: `own_departments` | `whole_hotel` | `own_only`; `portal.nameFormat`: `first_last_initial` ("Maria G.") | `full`.
`limitMode: "daily"` applies the daily maximum; `"weekly"` switches to the weekly maximum (for the planned Arbeitszeitgesetz change) without a code change.

---

## 5. Data model

```
companies 1─* hotels 1─* departments 1─* shifts 1─* shift_staffing_requirements
   │              ├─* kiosk_devices, kiosk_pairing_codes, leave_blackouts
   │              └─* user_hotel_access *─1 users (staff ─ employee; managers may be linked to an employee too)
   └─* employees ─* employee_hotels *─1 hotels        (exactly one home hotel; the others = floating)
          │  └─* employee_departments                 (departments of an assigned hotel)
          ├ employee-global:    1─1 employee_pins, employee_work_targets
          │                     1─* employee_vacation_allowance, time_offs ─* time_off_dates, employee_leave_wishes, inquiries ─* inquiry_messages
          └ per assigned hotel: schedules (shift | off; draft | published), employee_shift_wishes,
                                time_entries ─* time_entry_breaks, time_entry_corrections
users 1─* refresh_tokens, user_tokens, notifications, notification_preferences      audit_logs (append-only, PII-free)
```

Full DDL: **Appendix A**. The database itself enforces: **no overlapping shifts for an employee across all hotels** (checked on real instants in each hotel's timezone, including across midnight; split shifts are allowed, the service caps them per day); a day off excludes any other entry that day; the employee must be assigned to the hotel, and not unassigned before the date, for roster entries, time entries and shift wishes; department match; entry shape (shift needs a shift, off has none); published rows carry a timestamp; exactly one home hotel per employee and assignments only within the employee's company; no overlapping pending/approved absences (sick leave has its own non-overlap rule and may overlap vacation); no overlapping time entries (so one open entry per employee, across hotels); one open break per entry; break shorter than shift and than the worked time; shift and department belong to the same hotel; sick leave carries no reason; a correction needs a reason; a login needs an e-mail or a username; personnel numbers are unique per company; inquiry messages cannot be edited; audit rows cannot be changed.

---

## 6. Business rules

### R1. Hours
- `paidMinutes = durationMinutes − breakDurationMinutes`; API shows `paidHours = paidMinutes / 60` (2 decimals). Roster `off` entries count 0.
- Week = Monday–Sunday, month = calendar month, both hotel-local. A night shift counts toward its **start date**.
- Manager totals include draft and published entries; staff see totals from published entries only. Totals, limits and rest periods always count the employee's entries at **all hotels** (a floating employee's week is one week). A day's working time is the sum of all its shifts (split shifts); the gap between parts is not working time.

### R2. Hard blocks on roster entries (`POST/PATCH /schedules`, bulk, copy; nothing is saved)
| Code | Rule | HTTP |
|---|---|---|
| `SCHEDULE_DATE_IN_PAST` | date < today in hotel timezone (admin may send `allowPast: true`, audited) | 422 |
| `EMPLOYEE_ALREADY_SCHEDULED` | the same shift is assigned again, or a day off meets another entry that day (either order) | 409 |
| `SHIFT_OVERLAPS_EXISTING` | the shift overlaps another shift of the employee **at any hotel** (real instants, across midnight) | 409 |
| `MAX_SHIFTS_PER_DAY_EXCEEDED` | more than `roster.maxShiftsPerDay` (default 2) shifts on one day | 422 |
| `MINOR_PROTECTION_VIOLATION` | employee is under 18 on that date and a rule of R18 is broken (enforcement `block`) | 422 |
| `EMPLOYEE_ON_TIME_OFF` | an **approved** time-off covers the date (any type), also for `off` entries | 422 |
| `EMPLOYEE_NOT_IN_DEPARTMENT` | shift's department not among the employee's (shift entries only) | 422 |
| `EMPLOYEE_INACTIVE` | employee `terminated` (`on_leave` is informational, no effect) | 422 |
| `EMPLOYEE_NOT_ASSIGNED_TO_HOTEL` | employee is not assigned to this hotel on that date (never assigned, or unassigned before it) | 422 |
| `RESOURCE_NOT_FOUND` | employee/shift missing or other hotel | 404 |
| `VALIDATION_ERROR` | shift entry without `shiftId`, off entry with `shiftId`, etc. | 400 |

The database trigger reports every overlap, including the same shift twice, with one message; the service checks "same shift" first so the user gets the more precise `EMPLOYEE_ALREADY_SCHEDULED`.

### R3. Soft warnings (stored in `schedules.warnings`; severity `warning` or `info`; never block)
Totals and neighbouring shifts include the employee's entries at all hotels; warnings name the hotel (`hotelName`).
| Type | Trigger |
|---|---|
| `insufficient_rest_period` | gap to previous/next shift < `legal.restPeriodMinHours` |
| `exceeds_daily_max` | the day's paid hours (all shifts) > `legal.dailyMaxHours` (only if `limitMode = daily`) |
| `exceeds_legal_weekly_max` | projected week > `legal.weeklyMaxHours` (only if `limitMode = weekly`) |
| `exceeds_max_week` / `exceeds_max_month` | projected paid hours > the employee's max |
| `above_target_week` / `above_target_month` | above target, within max (info) |
| `below_target_week` / `below_target_month` | only if `roster.belowTargetOnAssign = true`; always shown in work-summary |
| `pending_time_off_overlap` | a **pending** absence request covers the date |
| `conflicts_with_wish` | pending/approved `avoid` wish for this shift or whole day (info) |
| `short_notice_change` | editing/deleting a **published** entry less than `roster.changeNoticeHours` before its start |
| `split_shift_span` | first start to last end of the day > `roster.maxDaySpanHours` (default 12), info |
| `minor_protection` | an R18 rule is broken (default mode `warn`); saving needs `overrideReason` while `legal.minors.requireOverrideReason` is on |
| `minor_weekend_holiday_check` | a minor is scheduled on a Saturday, Sunday or public holiday: check the legal exceptions and compensation day (info) |

If any `warning`-severity item is present the client may send `overrideReason`; it is stored and audited.

### R4. Rest period
1. For each neighbouring entry (date−1 and date+1, shift entries only, at any of the employee's hotels) build absolute instants from **local date + time in that entry's hotel timezone**: `start = zoned(date, startTime)`, `end = zoned(date + (1 day if the shift wraps midnight), endTime)`. Never compute `end = start + duration`: on clock-change nights the real length differs (a nominal 22:00–06:00 shift lasts 9 h on 25 Oct 2026 and 7 h on 29 Mar 2026).
2. `gap = newStart − prevEnd` (and `nextStart − newEnd`); gap < `restPeriodMinHours` → `insufficient_rest_period` with the gap and the neighbour. Only gaps between **different days' work** count: compare the previous day's **last** shift end with the first start of the new day (and symmetrically); the gap between two parts of the same day is not a rest period.
3. Responses always include `restPeriodHours` (smallest gap, or `null`).

### R5. Break rules on shift definitions
When a shift is created/updated, evaluate `legal.breakRules` against its gross time and break; if too short, the response carries `warnings: [{ type: "break_insufficient" }]` (soft). On a split day, gaps of at least 15 minutes between parts count as break time when the day's total is evaluated.

### R6. Absences vs the roster
Creating or approving an absence over dates with roster entries: default `409 TIME_OFF_CONFLICTS_WITH_SCHEDULE` listing them. **Exception: `sick_leave`** (not refusable) is accepted and returns `conflicts: [scheduleIds]`. Sending `unassignConflicts: true` (manager+, on create or on approve) deletes those entries in the same transaction (audited). Conflicting entries at **other hotels** are listed with `hotelName` and removed too: an absence takes precedence over any hotel's roster (deliberate cross-hotel exception, audited).

### R7. Absence types
| Type | Allowance | Blocks roster | Hours credit (R8) | Overlap rule |
|---|---|---|---|---|
| `annual_leave` | deducts | yes | yes | may not overlap other non-sick absences |
| `sick_leave` | no (certified sick days inside vacation are refunded) | yes | yes, up to `absence.sickCreditMaxDays` | may overlap vacation/others, not other sick leave |
| `unpaid_leave` | no | yes | no | as annual_leave |
| `school` | no | yes | yes (a school day credits a normal working day) | as annual_leave; **manager-created only** (vocational-school days and blocks of apprentices) |
| `other` | no | yes | no | as annual_leave |

Absences belong to the **employee**: once approved they block rostering at **every** hotel the employee is assigned to, and they are decided by a manager of the employee's **home hotel** (or admin). Managers of other hotels see only that the employee is `unavailable`, never the type. Blocking starts when status is `approved`. Flow: `pending → approved | rejected | cancelled`, `approved → cancelled`. Managers may create entries directly as `approved`. Staff create `pending` requests; a staff sick report is `pending` until a manager confirms it. Staff cannot create `school` entries. **Planned days off** are roster entries (`entryType: "off"`, label e.g. "Frei"): they count 0 hours, are draft/published like shifts, are one entry per day, and need no approval.

### R8. Counted days and credited hours
- **Counted days:** for each date in `[startDate, endDate]`, keep it only if its ISO weekday is in the employee's `workWeekdays` **and** it is not a public holiday for the region of the employee's **home hotel** (`hotels.holiday_region`). `startHalfDay`/`endHalfDay` make the first/last kept day 0.5 (both flags on a single day → 400). `timeOffDays` = sum of fractions, written to `time_off_dates` in the same transaction. Zero counted days → `422 NO_WORKING_DAYS_IN_RANGE`. Later changes to `workWeekdays` do not rewrite stored days.
- **Credit:** each approved `annual_leave` and `school` day, and each approved `sick_leave` day within the credit limit, credits `targetHoursPerWeek × 60 / cardinality(workWeekdays) × dayFraction` minutes toward weekly/month totals (work-summary, time account). Unpaid/other days credit nothing and **reduce** the monthly target proportionally. Credit never blocks anything.

### R9. Vacation allowance
`usedDays` and `pendingDays` come from view `v_vacation_usage` (certified sick days that overlap vacation are not counted). Per year:
- before `carryOverExpiresOn` (or if none): `remaining = vacationDaysPerYear + carriedOverDays − usedDays`
- after it: `remaining = vacationDaysPerYear + min(carriedOverDays, usedOnOrBeforeExpiry) − usedDays` (unused carry-over lapses).

Creating annual leave needing more than `remaining` in any affected year → `422 ALLOWANCE_EXCEEDED` (details per year). A request spanning New Year simply consumes days from both years. A missing allowance row is auto-created: 30 days if the employee has no earlier year, otherwise the previous year's yearly days plus automatic carry-over (SPEC 1.14). `PUT .../vacation-allowance` returns warning `below_statutory_minimum` for a minor when `vacationDaysPerYear` is below `ceil(minimumWerktage × workWeekdays / 6)`, where the minimum is 30 / 27 / 25 Werktage if the employee is under 16 / 17 / 18 at the start of the year (JArbSchG).

### R10. Wishes
- **Shift wish** (`kind: prefer | avoid`, priority 1–3): `shiftId` may be omitted only with `avoid`, meaning "I want this day off". Rejected for past dates, for dates where the employee already has an entry (409) or approved absence (422). One pending wish per employee+date+shift.
- **Leave wish:** employee-level (not tied to a hotel), future dates only, overlapping pending/approved wishes impossible; decided by a manager of the employee's home hotel.
- Approving a wish **never auto-schedules**. Sending `wishId` on `POST /schedules` (or `leaveWishId` on `POST /time-offs`) links and approves it.
- Employees can withdraw pending wishes (`cancelled`).
- **Lead time:** if `wishes.minLeadDays` is set, staff cannot submit wishes for dates closer than that many days (`422 WISH_DEADLINE_PASSED`); managers can enter wishes on behalf of staff.

### R11. Coverage
`shift_staffing_requirements` holds `minStaff` per shift and ISO weekday. Coverage for a date+shift = scheduled employees at that hotel (floating staff from other hotels included) vs `minStaff`. A leave wish's `coverageRisk` = dates where approving it, together with approved absences, would leave a shift below `minStaff`. No requirements defined → `null` (not "ok").

### R12. Roster lifecycle (draft → published)
- New entries are `draft`. Staff, the kiosk and wish/availability views see **published** entries only.
- `POST /schedules/publish { hotelId, from, to, departmentId? }` re-validates every draft in range against the hard blocks (an absence may have been approved since drafting). **All-or-nothing:** any conflict → `409 PUBLISH_CONFLICTS` with the list, nothing is published. Success sets `published_at/by`.
- `POST /schedules/unpublish` reverts to draft, future dates only (`422 SCHEDULE_DATE_IN_PAST` otherwise).
- Editing or deleting a published entry takes effect immediately, keeps it published, and adds `short_notice_change` inside the notice window. New entries added to an already published week stay draft until published again.
- Past entries are immutable (admin `allowPast`).
- Planned, not in this version: notifying staff on publish/changes (table-free: add an outbox later).

### R13. Attendance (shared hotel tablet)

**R13.1 Devices.** A manager creates a pairing code (10 min, single use) naming the device. The tablet submits it to `POST /kiosk/pair` and receives a 256-bit device token **once**; only its hash is stored. All other kiosk calls need `X-Device-Token`. Revoking a device takes effect on the next call. Optional per-hotel IP allow-list (`attendance.kioskAllowedIps`).

**R13.2 Identification.** The tablet lists employees **assigned to this hotel** with a **published shift today at this hotel** (window: 2 h before start until end, plus anyone with an open entry here), with search among this hotel's assignees for unscheduled staff; entries show `displayName` ("Maria G.") only. The employee taps their name and enters a **6-digit PIN**; `POST /kiosk/verify` returns a single-use `punchToken` (60 s) and the allowed actions; `POST /kiosk/punch` performs one. PINs are generated by the server, shown once to the manager (`POST /employees/:id/pin/reset`), stored as bcrypt hashes. One PIN works at every hotel the employee is assigned to; an employee not assigned to the tablet's hotel gets the same generic `INVALID_PIN` (no enumeration). `pinMaxAttempts` failures lock that employee's PIN for `pinLockMinutes` (audited, manager can unlock). No biometrics, photos or GPS in this version.

**R13.3 Server time only.** Every timestamp is the server's `now()`. Any time sent by a tablet is ignored. Responses include `serverTime` for display.

**R13.4 Actions.** `clock_in` (no open entry), `break_start` / `break_end` (only when `breakMode = recorded`, entry open), `clock_out` (entry open; closes an open break at the same instant). Wrong state → `409 INVALID_PUNCH_STATE`; an open entry in `needs_review` → `409 ENTRY_NEEDS_REVIEW` (see a manager). An open entry at **any** hotel blocks clocking in at another (nobody is in two places).

**R13.5 Linking and anomalies.** On `clock_in` the entry links to the employee's published shift whose window contains now (a night shift from yesterday still running counts); otherwise `unscheduled_work`. With split shifts it links to the not-yet-linked shift whose window contains now; after clock-out the employee may clock in again for the second part. Anomalies are recorded, never block, and never change timestamps (no rounding):
`early_clock_in` (> `earlyClockInMinutes` before start), `late_clock_in` (> `lateToleranceMinutes` after start), `early_clock_out`, `overtime` (> `overtimeToleranceMinutes` after end), `unscheduled_work`, `scheduled_elsewhere` (published shift today at another hotel), `during_time_off`, `missing_break`, `exceeds_daily_max`, and for minors `minor_outside_hours` / `minor_limit_exceeded` (these also notify the managers).

**R13.6 Breaks.** `auto` (default): at `clock_out`, `breakMinutes` = the shift's scheduled break if gross time ≥ 6 h, else 0; unscheduled work uses `legal.breakRules` by gross time. `recorded`: sum of recorded breaks; missing/short → `missing_break`. On a split day the test uses the day's total working time and counts gaps of at least 15 minutes between parts as break time; minors follow R18.

**R13.7 Forgotten clock-out.** An hourly job sets entries open longer than `needsReviewAfterHours` to `needs_review`. Unplanned entries are never auto-closed with invented times; a manager closes them through a correction. Planned-shift entries: see 1.13.

**R13.8 Corrections.** Entries are never edited in place. An employee (web login) **requests** a correction with a mandatory reason; a manager approves/rejects. A manager's own change is recorded as a correction row that is created already `approved` (reason mandatory). Approval snapshots the original values on the correction row and then updates the entry; the audit log records both. A manager can also add a missed day manually (`POST /attendance`, source `manager`, reason mandatory).

**R13.9 Period lock.** `hotels.attendance_locked_until`: entries whose local clock-in date is on or before it cannot be created, changed or corrected (`423 PERIOD_LOCKED`) except by an admin with a reason (audited). Managers may only move the lock forward.

**R13.10 Worked time and time account.** Worked minutes = `clockOut − clockIn − breakMinutes` for **closed** entries at **all hotels** (open/needs-review entries are excluded and flagged). Monthly: `delta = worked + credited − target` (target adjusted per R8). `balance = openingBalanceHours + Σ monthly deltas` since `balanceStartDate`.

**R13.11 No-show.** A published shift whose end (plus tolerance) has passed with no time entry and no approved absence is flagged `no_show` on the live board and in analytics. Employees with `attendanceRequired = false` are never flagged. A flag only; no automatic consequence.

### R14. Privacy and retention
- **Audit is PII-free:** `AuditService` stores entity IDs and non-personal field changes; it strips `firstName, lastName, email, phone, hourlyRate, password, pin` and similar keys. Unknown-user login failures store `sha256(email)`.
- **Sick leave:** only the fact and dates; no reason; read access limited to the employee and manager/admin of that hotel; analytics aggregated.
- **Anonymisation:** `POST /employees/:id/anonymize` (admin) on a terminated employee after `retention.timeRecordsYears` replaces name with "Former employee #id", clears email, phone, hourly rate, birth date, personnel number, PIN, linked login; roster, absence and time records stay for statutory retention; audit stays intact. Before the retention period only with `force: true` and a reason (audited), e.g. for a GDPR erasure request.
- **Birth date** is used only for age-based rules; readable by the employee, managers of the home hotel and admins.
- **Inquiries** are visible only to the employee and the managers of the routed hotel. Free text may contain personal data, so the UI warns against health details, message bodies are never copied into audit logs or e-mails, and closed inquiries are deleted after `retention.inquiriesMonths`.
- **Kiosk data minimisation:** the kiosk sees `displayName`, status and today's shift only.

### R15. Employee portal (browser)
- **Who:** every employee with a user account (`users.employeeId`), including managers who also work shifts. Responsive web app, no installation. Accounts are optional: staff without one still clock in on the tablet.
- **Sees and does:** dashboard (PO1); own roster (published, all assigned hotels); the hotel plan per `portal.planVisibility` (`own_departments` default and **confirmed**, `whole_hotel`, `own_only`; "own departments" = the departments the employee belongs to, at every hotel they are assigned to) with colleague names per `portal.nameFormat`, **shifts only**, never colleagues' days off, absences, wishes, hours or drafts; own hours (planned from the published roster, worked from closed time entries), targets, work summary and time account; vacation balance (remaining, pending, used), own absences, public holidays and leave blackouts; requests and wishes (annual/unpaid/other leave, sick report, shift and day-off wishes, leave wishes, correction requests, withdrawals); questions to managers (R16); notifications (R17); profile (phone, language), own sessions, password, kiosk PIN.
- **Cannot:** see other people's hours, rates or absences; approve or edit anything; see drafts; change name, e-mail, rate or targets (managers do).
- **Termination:** when an employee's `terminatedOn` date has passed, the linked user is disabled, refresh tokens are revoked and the PIN is deleted (daily job); the kiosk no longer lists them.

### R16. Inquiries (employee questions)
- An employee opens an inquiry: `subject` (max 120), `category` (`roster`, `hours`, `vacation`, `attendance`, `other`), first message `body` (max 4000), optional `related` `{ type: schedule | time_entry | time_off | shift_wish | leave_wish | correction, id }`. No attachments, no real-time chat.
- **Routing:** `hotelId` = the related entry's hotel, else the employee's home hotel. The employee and every manager whose access set contains that hotel (and admins) can read it; those managers are notified and any of them may reply or set `assignedToId`. Managers of other hotels cannot see it.
- **Status:** `open` → manager reply → `answered` → employee reply → `open`; either side may set `closed`; a new message on a closed inquiry reopens it. Messages are append-only.
- **Not for sickness:** the UI states that sickness is reported through the sick report and that health details do not belong in messages. Limit 20 new inquiries per employee and day. Closed inquiries are deleted after `retention.inquiriesMonths`.

### R17. Notifications
- In-app notifications for every user; e-mail optional per kind if the user has an e-mail address and the preference allows it. Users without e-mail receive in-app notifications only.
- **Kinds and recipients:** `roster_published` (employees with published entries in the range, one per publish), `roster_entry_changed` / `roster_entry_removed` (employee, published entries only, immediate, `urgent` inside the notice window), `absence_decided`, `wish_decided`, `correction_decided`, `inquiry_reply` (employee); `inquiry_new`, `absence_requested`, `wish_submitted`, `correction_requested`, `needs_review_entry`, `sick_reported`, `time_approval_requested` (managers whose access set contains the relevant hotel; absences go to the home hotel); `time_approval_decided` (employee).
- **Content:** `kind`, `params` (ids and dates only, never health details), `entityType`, `entityId`; the client renders the text in the user's language. E-mails carry a generic text and a link, never the content.
- **Defaults:** e-mail on for entry changed/removed, decisions, replies and `sick_reported`; off for the rest. A job sends due e-mails every minute (retry 3 times).

### R18. Minors and apprentices
- **Data:** `birthDate`, `employmentType` (`full_time`, `part_time`, `mini_job`, `working_student`, `apprentice`, `intern`, `other`). An employee is a **minor** on a date if under 18 on that date (rules end on the birthday); under 15 cannot be created (`400`).
- **Rule set** `legal.minors` (enforcement `warn` default, or `block`). Core limits were checked against the Hessian labour ministry's hotel/restaurant leaflet and chamber-of-commerce summaries of the Jugendarbeitsschutzgesetz (JArbSchG); items marked * need legal confirmation.

| Rule name | Default |
|---|---|
| `daily_limit` | working time of the day (sum of shifts) ≤ 8 h (the law allows 8.5 h on some days with compensation; not modelled, raise in settings only if your adviser confirms) |
| `weekly_limit` | Monday–Sunday working time **plus credited school time** ≤ 40 h |
| `days_per_week` | at most 5 days with shifts per week |
| `shift_span` | first start to last end of the day, breaks and gaps included, ≤ 11 h (hotels/restaurants) |
| `rest_period` | ≥ 12 h between the end of one working day and the start of the next |
| `earliest_start`, `latest_end`, `night_work` | shifts only between 06:00 and 20:00; employees aged 16+ in hotels/restaurants until 22:00; a shift may not cross midnight |
| `break` | working time > 4.5 h up to 6 h: ≥ 30 min break; > 6 h: ≥ 60 min; breaks count only in blocks of ≥ 15 min (gaps between split parts count); never more than 4.5 h without a break |

- **School:** a `school` absence blocks the day and credits working time (apprentices of any age).
- **Not enforced in v2.3 (warning `minor_weekend_holiday_check` only):* Saturday/Sunday/holiday exceptions and compensation days, 24 and 31 December after 14:00, the 23:00 multi-shift exception, "no work before school starting before 09:00" beyond the school-day block.
- **Warn mode (default):** the entry is saved and the response carries a `minor_protection` warning with `details: [ { rule, limit, actual } ]`; the UI must show it distinctly from ordinary warnings. The manager decides, but while `requireOverrideReason` is on (default) saving needs a written `overrideReason`, otherwise `422 OVERRIDE_REASON_REQUIRED`; reason, rules and manager are audited. In bulk and copy the reason is given per item (`overrideReason`), items without it fail individually; publish never blocks on warnings. With warn mode the responsibility for any breach of the JArbSchG stays with the hotel.
- **Block mode:** a violating `POST/PATCH /schedules`, bulk, copy or publish entry answers `422 MINOR_PROTECTION_VIOLATION` with the same `details`; managers cannot override it (changing the hotel setting is an admin act).
- **Attendance:** a kiosk punch is never refused, but outside-window or over-limit work by a minor is flagged (`minor_outside_hours`, `minor_limit_exceeded`) and notifies the managers.
- Not modelled: medical check-ups, training plans, exam leave beyond `school` entries.

### R19. Accounts without e-mail
- A login is an **e-mail or a username** (3–40 chars: lowercase letters, digits, `.`, `_`); login accepts either. `employeeNumber` (personnel number) is unique per company; suggested username `firstname.lastname`, collisions get a number.
- **Hand-over:** `POST /users/:id/invite { "deliver": "link" }` returns a single-use URL (valid 7 days, shown once) for the manager to hand over in person or as a QR code; the employee sets their own password in the browser. No temporary passwords exist.
- **Reset without e-mail:** `POST /users/:id/password-reset-link` (manager of the employee's hotels, 1-hour single-use link, sessions revoked on use, audited). `forgot-password` works only for accounts with an e-mail.

### R20. Cover finder
`GET /schedules/candidates?hotelId&date&shiftId` lists employees who could take the shift: assigned to the hotel (floating staff included) and active, department matches, no overlapping shift and no approved absence that day, no hard-block (including R18 in block mode; in warn mode candidates that would trigger minor warnings are listed but flagged). Each candidate carries the warnings the assignment would produce, weekly hours so far and their wish for that day (`prefer` / `avoid`). Order: `prefer` wishes, then no warnings, then fewer weekly hours. Read-only: the manager assigns with a normal `POST /schedules`, nobody is contacted automatically.

### R21. Payroll export
- **Generic:** `GET /hotels/:id/payroll-export?month=YYYY-MM&format=csv|json`: per employee with entries at the hotel: personnel number, names, employment type, worked minutes (closed entries at this hotel), planned minutes, credited minutes (annual, sick, school), absence days by type, `nightMinutes` (`payroll.nightFrom`–`nightTo`), `saturdayMinutes`, `sundayMinutes`, `holidayMinutes` (public holidays of the hotel's region); the unpaid break is deducted automatically from these supplement minutes in proportion to worked ÷ gross time (1.7), count of open/needs-review entries, time-account delta. Supplement rules depend on the collective agreement: confirm with payroll. `GET /attendance/export?hotelId&from&to&format=csv`: one line per time entry. If the month is not yet covered by `attendance_locked_until` the JSON carries `warnings: ["period_not_locked"]` (lock first, then export).
- **DATEV Lohn (required): `format=datev`.** Returns the monthly movement data (Bewegungsdaten) as an ASCII import file (`text/plain; charset=windows-1252`, CRLF, decimal comma, dates `DD.MM.YYYY`). Which DATEV payroll product is used (LODAS or Lohn und Gehalt) is **not yet known**: your external payroll office decides (`payroll.datev.product` = `lodas` or `lug` once confirmed). Because the file is template-driven, either works as long as the office supplies a sample file it has accepted; what is described below was verified for **LODAS**.
  - *What is known:* LODAS imports an ASCII file with the sections `[Allgemein]`, `[Satzbeschreibung]` (record description) and `[Bewegungsdaten]` (data lines); a movement line carries the personnel number, a date, a value, a processing key (`1` = hours, `10` = days, `71` = vacation days statistical, `72` = sick days statistical) and the client's own wage type (`la_eigene`); the record description decides **which LODAS table** the data lands in (a wrong one ends up in "Nachberechnung Standard" instead of the standard table) (DATEV community answers by DATEV staff; official reference: *Schnittstellenhandbuch LODAS*, DATEV help document 1080789).
  - *Therefore nothing is hard-coded:* the file is produced from three templates in `payroll.datev`: `headerTemplate` (`[Allgemein]` block, placeholders `{consultantNumber}`, `{clientNumber}`, `{month}`), `recordDescriptionTemplate` and `lineTemplate` (placeholders `{pnr}`, `{date}`, `{value}`, `{key}`, `{wageType}`, `{note}`). They are copied from a sample file **your payroll office has accepted**. Lines: one per employee and wage type, value = hours (minutes ÷ 60, 2 decimals, rounded once per month and type, never per day) or days; hours = worked minutes of closed entries at this hotel plus credited minutes; supplements = night/Saturday/Sunday/holiday minutes (break deducted).
  - *Guards:* wage-type numbers are client-specific in DATEV. Until `consultantNumber`, `clientNumber`, the templates and every wage type needed for the month are set, the export answers `422 PAYROLL_MAPPING_INCOMPLETE` listing what is missing. Employees without `employeeNumber` → `422 VALIDATION_ERROR` listing them (the personnel number must equal the one in LODAS).
  - *Acceptance:* a golden-file test against the approved sample (test 116); the first real import runs in a DATEV test client together with the payroll office. If the office uses *Lohn und Gehalt* instead of LODAS, only the three templates change (question O16).

### R22. Leave blackouts and wish lead time
- `leave_blackouts` (hotel, date range, reason, `mode` `warn`|`block`), e.g. trade-fair weeks. An annual-leave request overlapping a blackout of the employee's **home hotel**: `warn` → warning `leave_blackout` shown to employee and approver; `block` → `422 LEAVE_BLACKOUT` for staff, managers may proceed with `overrideReason`. Sick leave is never affected.
- `wishes.minLeadDays`: see R10.

---

## 7. Authorization

| Action | staff | manager (own hotel(s)) | admin |
|---|---|---|---|
| Login, `me`, change password, own PIN | ✓ | ✓ | ✓ |
| Own schedule (published), wishes, absences, allowance, attendance, time account | ✓ | ✓ | ✓ |
| Colleagues' published shifts per `portal.planVisibility` (name per `portal.nameFormat` + shift only) | ✓ | ✓ | ✓ |
| Dashboard, profile (phone, language), notification settings, own sessions, questions to managers | ✓ | ✓ | ✓ |
| Create own wishes/requests, sick report, correction request; withdraw own pending | ✓ | ✓ | ✓ |
| Employee master data, rates, targets, allowance write, PIN reset/unlock, absence decisions | ✗ | ✓ if the employee's **home hotel** is in the access set | ✓ |
| See employees assigned to my hotel, floating staff included (name, status, availability) | ✗ | ✓ | ✓ |
| Assign/unassign an employee to a hotel | ✗ | ✓ if all hotels involved are in the access set | ✓ |
| Delete another hotel's `off` entry for a floating employee | ✗ | ✓ if the employee is assigned to my hotel | ✓ |
| Departments, staffing requirements | ✗ | ✓ | ✓ |
| Shift templates (create/edit/delete) | ✗ | ✗ | ✓ |
| Add / delete employees | ✗ | ✗ | ✓ |
| Roster: create/edit/delete/bulk/copy/publish, see drafts | ✗ | ✓ | ✓ |
| Approve/reject absences, wishes, corrections, hours of unplanned work; manual time entries | ✗ | ✓ | ✓ |
| Kiosk pairing/devices, period lock (forward only) | ✗ | ✓ | ✓ |
| Analytics, live board, audit log | ✗ | ✓ | ✓ |
| Users: create/invite/disable staff in own hotels, hand-over and reset links | ✗ | ✓ | ✓ |
| Answer inquiries routed to my hotels, leave blackouts, cover finder, payroll export | ✗ | ✓ | ✓ |
| Read an employee's birth date | own only | ✓ if home hotel in access set | ✓ |
| Create managers/admins, set `hotel-access`, hotel settings write, companies/hotels, anonymise, move lock backward | ✗ | ✗ | ✓ |
| Cross-hotel overview (`/analytics/overview`) | ✗ | only hotels in own access set | all |
| Kiosk endpoints | device token only (no user session) | | |

**Floating staff:** a manager of a non-home hotel can roster the employee and sees their total hours, rest-period conflicts, shifts at other hotels (hotel name + times) and `unavailable` days. They do not see hourly rate, contact data, absence types or time-off requests, and cannot edit master data.

---

## 8. Endpoint catalog (`/api/v1`)

Role: **P** public, **S** staff and up, **M** manager and up, **A** admin, **D** kiosk device token. Phase = build phase (Section 13).

| ID | Method | Path | Role | Ph |
|----|--------|------|------|----|
| H1 | GET | /health | P | 0 |
| H2 | GET | /ready | P | 0 |
| A1 | POST | /auth/login | P | 1 |
| A2 | POST | /auth/refresh | P | 1 |
| A3 | POST | /auth/logout | S | 1 |
| A4 | GET | /auth/me | S | 1 |
| A5 | POST | /auth/change-password | S | 1 |
| A6 | POST | /auth/accept-invite | P | 1 |
| A7 | POST | /auth/forgot-password | P | 1 |
| A8 | POST | /auth/reset-password | P | 1 |
| A9 | GET | /auth/sessions | S | 1 |
| A10 | DELETE | /auth/sessions/:id | S | 1 |
| A11 | POST | /auth/logout-all | S | 1 |
| O1 | GET | /companies | A | 1 |
| O2 | POST | /companies | A | 1 |
| O3 | PATCH | /companies/:id | A | 1 |
| O4 | GET | /hotels | M | 1 |
| O5 | POST | /hotels | A | 1 |
| O6 | PATCH | /hotels/:id | A | 1 |
| O7 | DELETE | /hotels/:id | A | 1 |
| O8 | GET | /hotels/:id/settings | M | 1 |
| O9 | PUT | /hotels/:id/settings | A | 1 |
| U1 | GET | /users | M | 1 |
| U2 | POST | /users | M | 1 |
| U3 | PATCH | /users/:id | M | 1 |
| U4 | DELETE | /users/:id | M | 1 |
| U5 | POST | /users/:id/invite | M | 1 |
| U6 | PUT | /users/:id/hotel-access | A | 1 |
| U7 | POST | /users/:id/password-reset-link | M | 1 |
| D1 | GET | /departments | S | 2 |
| D2 | POST | /departments | M | 2 |
| D3 | PATCH | /departments/:id | M | 2 |
| D4 | DELETE | /departments/:id | M | 2 |
| S1 | GET | /shifts | S | 2 |
| S2 | POST | /shifts | A | 2 |
| S3 | PATCH | /shifts/:id | A | 2 |
| S4 | DELETE | /shifts/:id | A | 2 |
| S5 | GET | /shifts/:id/staffing-requirements | M | 2 |
| S6 | PUT | /shifts/:id/staffing-requirements | M | 2 |
| E1 | GET | /employees | M | 3 |
| E2 | GET | /employees/:id | M | 3 |
| E3 | POST | /employees | A | 3 |
| E4 | PATCH | /employees/:id | M | 3 |
| E5 | DELETE | /employees/:id | A | 3 |
| E6 | GET | /employees/:id/work-targets | M | 3 |
| E7 | PUT | /employees/:id/work-targets | M | 3 |
| E12 | PUT | /employees/:id/hotels | M | 3 |
| PH1 | GET | /public-holidays | S | 3 |
| T0 | POST | /time-offs/preview | S | 4 |
| T1 | GET | /time-offs | M | 4 |
| T2 | GET | /employees/:id/time-offs | S | 4 |
| T3 | POST | /employees/:id/time-offs | S | 4 |
| T4 | PATCH | /time-offs/:id | S | 4 |
| T5 | DELETE | /time-offs/:id | S | 4 |
| B1 | GET | /leave-blackouts | S | 4 |
| B2 | POST | /leave-blackouts | M | 4 |
| B3 | DELETE | /leave-blackouts/:id | M | 4 |
| E9 | GET | /employees/:id/vacation-allowance | S | 4 |
| E10 | PUT | /employees/:id/vacation-allowance | M | 4 |
| C1 | GET | /schedules | S | 5 |
| C2 | GET | /schedules/:id | S | 5 |
| C3 | POST | /schedules/validate | M | 5 |
| C4 | POST | /schedules | M | 5 |
| C5 | PATCH | /schedules/:id | M | 5 |
| C6 | DELETE | /schedules/:id | M | 5 |
| C7 | GET | /schedules/coverage | M | 5 |
| C8 | POST | /schedules/bulk | M | 5 |
| C9 | POST | /schedules/copy | M | 5 |
| C10 | POST | /schedules/publish | M | 5 |
| C11 | POST | /schedules/unpublish | M | 5 |
| C12 | GET | /schedules/candidates | M | 5 |
| E8 | GET | /employees/:id/work-summary | S | 5 |
| K1 | POST | /kiosk/pair | P | 6 |
| K2 | GET | /kiosk/roster | D | 6 |
| K3 | POST | /kiosk/verify | D | 6 |
| K4 | POST | /kiosk/punch | D | 6 |
| K5 | POST | /kiosk/pairing-codes | M | 6 |
| K6 | GET | /kiosk/devices | M | 6 |
| K7 | DELETE | /kiosk/devices/:id | M | 6 |
| P1 | POST | /employees/:id/pin/reset | M | 6 |
| P2 | PUT | /employees/me/pin | S | 6 |
| P3 | POST | /employees/:id/pin/unlock | M | 6 |
| AT1 | GET | /attendance | S | 6 |
| AT2 | GET | /attendance/:id | S | 6 |
| AT3 | POST | /attendance | M | 6 |
| AT4 | PATCH | /attendance/:id | M | 6 |
| AT5 | POST | /attendance/:id/corrections | S | 6 |
| AT6 | GET | /attendance/corrections | S | 6 |
| AT7 | PATCH | /attendance/corrections/:id | S | 6 |
| AT8 | GET | /attendance/live | M | 6 |
| AT9 | PUT | /hotels/:id/attendance-lock | M | 6 |
| AT10 | GET | /attendance/export | M | 6 |
| AT11 | GET | /hotels/:id/payroll-export | M | 6 |
| AT12 | PATCH | /attendance/:id/approval | M | 6 |
| E13 | GET | /employees/:id/time-account | S | 6 |
| W1 | GET | /shift-wishes | S | 7 |
| W2 | POST | /employees/:id/shift-wishes | S | 7 |
| W3 | PATCH | /shift-wishes/:id | S | 7 |
| W4 | GET | /leave-wishes | S | 7 |
| W5 | POST | /employees/:id/leave-wishes | S | 7 |
| W6 | PATCH | /leave-wishes/:id | S | 7 |
| W7 | GET | /hotels/:id/planning-dashboard | M | 7 |
| PO1 | GET | /me/dashboard | S | 8 |
| PR1 | GET | /me/profile | S | 8 |
| PR2 | PATCH | /me/profile | S | 8 |
| NT1 | GET | /notifications | S | 8 |
| NT2 | PATCH | /notifications/:id | S | 8 |
| NT3 | POST | /notifications/read-all | S | 8 |
| NT4 | GET | /me/notification-preferences | S | 8 |
| NT5 | PUT | /me/notification-preferences | S | 8 |
| IN1 | POST | /inquiries | S | 8 |
| IN2 | GET | /inquiries | S | 8 |
| IN3 | GET | /inquiries/:id | S | 8 |
| IN4 | POST | /inquiries/:id/messages | S | 8 |
| IN5 | PATCH | /inquiries/:id | S | 8 |
| N1 | GET | /hotels/:id/analytics/absences | M | 9 |
| N2 | GET | /hotels/:id/analytics/absences/trend | M | 9 |
| N3 | GET | /hotels/:id/analytics/hours | M | 9 |
| N4 | GET | /audit-logs | M | 9 |
| N5 | GET | /hotels/:id/analytics/attendance | M | 9 |
| N6 | GET | /analytics/overview | M | 9 |
| E11 | POST | /employees/:id/anonymize | A | 10 |

Notes: `S` on PATCH/DELETE of time-offs, wishes and corrections means "own pending item only" for staff; managers act on any item in their hotels. Staff on `/attendance*` and `/employees/:id/*` see only themselves. `DELETE` on departments, shifts and employees is a soft delete and returns `409 RESOURCE_IN_USE` while future roster entries exist.

`GET /employees?hotelId` lists everyone **assigned** to that hotel, floating staff included (`isHome: false`); managers of a non-home hotel get a reduced view (no rate, no contact data). `GET /time-offs?hotelId` returns absences of employees assigned to the hotel; for floating staff whose home hotel is elsewhere it returns only `{ employeeId, startDate, endDate, status: "unavailable" }`.

Staff calling `E8`, `W1`, `W4`, `T2`, `AT1`, `AT6` and `E13` see **only their own** data (`me`).

### 8.1 Key payloads

**Login (A1)** `{ login, password }` where `login` is the e-mail **or** the username. Native/other clients get `{ accessToken, refreshToken, expiresIn: 900, user }`. With header `X-Client: web` the refresh token is **not** in the body but in cookie `refresh_token` (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`) and the body is `{ accessToken, expiresIn, user }`. `user` = `{ id, email, username, firstName, role, hotelIds, employeeId, preferredLanguage }`. `POST /auth/refresh` reads the cookie (web) or `{ refreshToken }`, rotates it and returns a new access token; browser calls to refresh/logout need `X-Requested-With: XMLHttpRequest` and an allowed `Origin` (else `403 CSRF_REJECTED`). Lifetimes: access 15 min, refresh 30 days sliding, absolute 90 days. `GET /auth/sessions` → `[ { id, createdAt, lastUsedAt, userAgent, ip, current } ]`; `DELETE /auth/sessions/:id` and `POST /auth/logout-all` revoke sessions. Login errors never reveal whether an account exists.

**Invite flow:** `POST /users { email, role, employeeId?, hotelIds[] }` creates the user as `invited` and e-mails a link (7-day, single-use token). `POST /auth/accept-invite { token, password }` activates it and logs in. `POST /auth/forgot-password { email }` always answers `200` (no account enumeration); `POST /auth/reset-password { token, password }` (1-hour token) revokes all refresh tokens. If the mailer is disabled (dev), the invite/reset link is returned in the response instead.

**Employee (E1–E4, E12)**
```json
POST /employees  { "firstName": "Maria", "lastName": "Garcia", "email": "...", "phone": "...", "hourlyRate": 15.5,
                   "status": "active", "workWeekdays": [1,2,3,4,5], "employeeNumber": "P100", "birthDate": "2010-03-04", "hiredOn": "2026-09-01", "employmentType": "apprentice", "attendanceRequired": true, "homeHotelId": 1, "hotelIds": [1, 2], "departmentIds": [1, 3] }
201 { "id": 7, "firstName": "Maria", ..., "workWeekdays": [1,2,3,4,5], "homeHotelId": 1,
      "hotels": [ { "id": 1, "name": "Frankfurt", "isHome": true }, { "id": 2, "name": "Berlin", "isHome": false } ],
      "departments": [ { "id": 1, "name": "Front Desk", "color": "#2f62b3", "hotelId": 1 }, { "id": 3, "name": "Front Desk", "color": "#2f62b3", "hotelId": 2 } ] }
PUT /employees/7/hotels  { "hotelIds": [1, 2, 3], "homeHotelId": 1 }
```
`departmentIds` must belong to the listed hotels. Dropping a hotel that has future roster entries or an open time entry → `409 RESOURCE_IN_USE`; a dropped assignment keeps its history (`unassigned_on`) and blocks new entries from that date. Changing the home hotel needs an admin or a manager with all involved hotels in their access set.

**Shift (S1/S2):** `{ id, hotelId, departmentId, name, startTime, endTime, durationHours, breakDurationMinutes, paidHours, warnings:[{type:"break_insufficient",severity,message}] }`

**Time-off preview (T0)** and **create (T3)**
```json
POST /time-offs/preview
{ "employeeId": 1, "type": "annual_leave", "startDate": "2026-10-12", "endDate": "2026-10-16",
  "startHalfDay": false, "endHalfDay": true }
200 { "timeOffDays": 3.5,
      "days": [ { "date": "2026-10-12", "fraction": 1.0 }, { "date": "2026-10-13", "fraction": 1.0 },
                { "date": "2026-10-15", "fraction": 1.0 }, { "date": "2026-10-16", "fraction": 0.5 } ],
      "skipped": [ { "date": "2026-10-14", "reason": "public_holiday", "name": "Example holiday" } ],
      "allowance": { "year": 2026, "remainingBefore": 22.0, "remainingAfter": 18.5 },
      "conflicts": { "scheduleIds": [] } }
POST /employees/1/time-offs   same body + { "reason": "Autumn break", "unassignConflicts": false, "leaveWishId": 201 }
201 { "id": 5, "status": "pending", "timeOffDays": 3.5, ... "conflicts": [] }
```
(The skipped-holiday line is only an illustration of the shape.) Sick leave: same endpoint with `type: "sick_leave"` and **no `reason`** (400 if sent). Approve: `PATCH /time-offs/5 { "status": "approved", "unassignConflicts": true }`; certificate: `PATCH { "medicalCertificateReceived": true }`.

**Allowance (E9):** `{ employeeId, year, vacationDaysPerYear, carriedOverDays, carryOverExpiresOn, carryOverAutomatic, alreadyTakenDays, usedDays, pendingDays, remainingDays }`

**Roster entry create / dry run (C4 / C3)**: same body, same response; C3 never writes.
```json
POST /schedules
{ "hotelId": 1, "entryType": "shift", "employeeId": 1, "shiftId": 2, "date": "2026-10-05",
  "overrideReason": "Short-staffed, agreed with employee", "wishId": 101 }
201 { "id": 123, "status": "draft", "entryType": "shift", "date": "2026-10-05",
      "employee": { "id": 1, "firstName": "Maria", "lastName": "Garcia" },
      "shift": { "id": 2, "name": "Late", "departmentId": 1, "startTime": "14:00", "endTime": "22:00",
                 "durationHours": 8.0, "breakDurationMinutes": 30, "paidHours": 7.5 },
      "paidHoursAssigned": 7.5, "currentWeekHours": 37.5, "currentMonthHours": 112.5,
      "weeklyTarget": 40.0, "monthlyTarget": 160.0, "restPeriodHours": 8.0,
      "warnings": [ { "type": "insufficient_rest_period", "severity": "warning",
                      "message": "Only 8 hours since previous shift (recommended minimum: 11)",
                      "previousShift": { "date": "2026-10-04", "shiftName": "Late", "endTime": "22:00", "hotelName": "Frankfurt" } } ] }
```
Off entry: `{ "entryType": "off", "employeeId": 1, "date": "2026-10-20", "offLabel": "Frei" }` (no `shiftId`). C3 returns `200` without `id`. `PATCH /schedules/:id { shiftId?, employeeId?, offLabel?, overrideReason? }` re-runs all rules. `GET /schedules?hotelId&from&to&departmentId&employeeId&status` returns `{ data:[{ id, status, entryType, date, employee, shift, offLabel, warnings }] }`; staff get published entries only, without `warnings`.

**Bulk (C8)** `POST /schedules/bulk { hotelId, mode: "partial" | "atomic", items: [ { entryType, employeeId, shiftId?, date, offLabel?, overrideReason? } ] }` (max 500) →
`200 { results: [ { index, status: "created" | "error", id?, warnings?, error?: { code, message } } ], summary: { created, failed } }`. In `atomic` mode any error rolls everything back (`409 BULK_FAILED`, same results).

**Copy (C9)** `POST /schedules/copy { hotelId, sourceFrom, sourceTo, targetFrom, departmentId?, employeeIds?, overwrite: false }` shifts every entry by `targetFrom − sourceFrom` days, creates **drafts**, and answers like bulk plus `skipped: [ { employeeId, date, reason } ]` (e.g. approved leave, terminated, already scheduled). Target dates must be in the future.

**Publish / unpublish (C10/C11)** `POST /schedules/publish { hotelId, from, to, departmentId? }` → `200 { published: 118, from, to }` or `409 PUBLISH_CONFLICTS { details: [ { scheduleId, code } ] }`.

**Coverage (C7)** `GET /schedules/coverage?hotelId&from&to&departmentId` → `{ data:[{ date, shiftId, shiftName, departmentId, scheduled, minStaff, understaffed }] }`

**Work summary (E8)** `GET /employees/1/work-summary?from&to` →
`{ employeeId, from, to, scheduledPaidHours, creditedHours, targetHours, delta, weeks:[{ weekStart, scheduledPaidHours, creditedHours, targetHours, status }], warnings:[...] }` with `status` ∈ `below | on_target | above | over_max`.

**Kiosk flow (K1–K4)**
```json
POST /kiosk/pair   { "pairingCode": "7K4-92M-QX" }
200 { "deviceToken": "…shown once…", "device": { "id": 3, "name": "Front desk tablet" },
      "hotel": { "id": 1, "name": "Frankfurt", "timezone": "Europe/Berlin" } }

GET /kiosk/roster?search=  (X-Device-Token)
200 { "serverTime": "2026-10-05T04:01:12Z",
      "employees": [ { "id": 1, "displayName": "Maria G.", "status": "not_in",
                       "todayShifts": [ { "name": "Early", "startTime": "06:00", "endTime": "14:00" } ] } ] }

POST /kiosk/verify { "employeeId": 1, "pin": "483920" }
200 { "punchToken": "…60 s, single use…", "displayName": "Maria G.", "status": "not_in",
      "allowedActions": [ "clock_in" ], "reasonRequiredForClockIn": false, "todayShifts": [ ... ] }
401 INVALID_PIN { "attemptsLeft": 3 }      423 PIN_LOCKED { "lockedUntil": "..." }

POST /kiosk/punch  { "punchToken": "...", "action": "clock_in", "reason": "only when unplanned (1.12)" }
201 { "timeEntryId": 881, "action": "clock_in", "at": "2026-10-05T04:02:03Z", "displayName": "Maria G.",
      "anomalies": [ ], "workedMinutesToday": 0 }
```
`status` ∈ `not_in | in | on_break`. The tablet never sends a time.

**PIN (P1–P3):** `POST /employees/1/pin/reset` → `{ "pin": "483920" }` (shown once). `PUT /employees/me/pin { currentPassword, newPin }`. `POST /employees/1/pin/unlock` → 204.

**Attendance entry (AT1/AT2)**
```json
{ "id": 881, "employeeId": 1, "scheduleId": 124, "status": "closed",
  "clockInAt": "2026-10-05T04:02:03Z", "clockOutAt": "2026-10-05T12:05:40Z",
  "breakMinutes": 30, "workedMinutes": 453, "sourceIn": "kiosk", "sourceOut": "kiosk",
  "anomalies": [ { "type": "late_clock_in", "minutes": 2 } ], "note": null,
  "corrections": [ { "id": 12, "status": "approved", "reason": "...", "decidedAt": "..." } ] }
```
`GET /attendance?hotelId&from&to&employeeId&status&anomaly`. Manual entry `POST /attendance { hotelId, employeeId, clockInAt, clockOutAt?, breakMinutes?, reason }` (manager). Direct manager change `PATCH /attendance/:id { clockInAt?, clockOutAt?, breakMinutes?, reason }` (creates an approved correction row).

**Corrections (AT5–AT7):** `POST /attendance/881/corrections { proposedClockOutAt, proposedBreakMinutes?, reason }` → `201 { id, status: "pending" }`. List `GET /attendance/corrections?hotelId&status`. Decide `PATCH /attendance/corrections/12 { "status": "approved" | "rejected" | "cancelled", "decisionNote" }` (staff may only set `cancelled` on their own pending one).

**Live board (AT8):** `GET /attendance/live?hotelId&departmentId` →
```json
{ "serverTime": "...",
  "clockedIn": [ { "employee": { "id": 1, "displayName": "Maria G." }, "since": "...", "onBreak": false,
                   "shift": { "name": "Early" }, "anomalies": [] } ],
  "expectedNotArrived": [ { "employee": { "id": 2, "displayName": "Jon S." }, "shift": { "name": "Early", "startTime": "06:00" }, "minutesLate": 14 } ],
  "noShows": [ ], "needsReview": [ { "timeEntryId": 870, "employee": { ... }, "openSince": "..." } ] }
```

**Period lock (AT9):** `PUT /hotels/1/attendance-lock { "lockedUntil": "2026-09-30" }`.

**Time account (E13):** `GET /employees/1/time-account?from=2026-08&to=2026-10` →
`{ employeeId, openingBalanceHours, months: [ { month: "2026-10", workedHours, creditedHours, targetHours, deltaHours, openEntries: 0 } ], balanceHours }`

**Wishes (W2/W5/W3/W6):** shift wish `{ date, shiftId?, kind, priority, reason }` (omit `shiftId` with `kind: "avoid"` for "day off"); leave wish `{ startDate, endDate, leaveDays, priority, reason }`; decision `PATCH { status, decisionNote }`.

**Planning dashboard (W7):** `GET /hotels/1/planning-dashboard?from&to` →
`{ period, shiftWishes:[{ id, employee, department, date, shift|null, kind, priority, reason, status }], leaveWishes:[{ id, employee, startDate, endDate, leaveDays, priority, status, coverageRisk: { level, understaffedDates[] } | null }], summary:{ pendingShiftWishes, pendingLeaveWishes } }`

**Public holidays (PH1):** `GET /public-holidays?hotelId&year` → `{ data:[{ date, name }] }` (from `date-holidays`, region from the hotel).

**Hotel settings (O8/O9):** the JSON in Section 4; `PUT` validates the whole object with zod.

**Accounts without e-mail (U2, U5, U7)**
```json
POST /users  { "username": "jon.s", "role": "staff", "employeeId": 12 }            (no e-mail)
201 { "id": 40, "username": "jon.s", "status": "invited" }
POST /users/40/invite  { "deliver": "link" }
200 { "inviteUrl": "https://app.example/accept-invite?token=...", "expiresAt": "..." }   shown once, valid 7 days
POST /users/40/password-reset-link
200 { "resetUrl": "https://app.example/reset-password?token=...", "expiresAt": "..." }  valid 1 h; sessions revoked on use
```
`deliver: "email"` (default when an e-mail exists) sends the link instead. The employee always sets their own password.

**Employee dashboard (PO1)**
```json
GET /me/dashboard
{ "today": { "status": "not_in", "shifts": [ { "hotelName": "Frankfurt", "name": "Early", "startTime": "06:00", "endTime": "14:00" } ] },
  "nextShifts": [ { "date": "2026-10-06", "hotelName": "Berlin", "shiftName": "Late", "startTime": "14:00", "endTime": "22:00" } ],
  "week":  { "plannedHours": 32.0, "workedHours": 15.5, "creditedHours": 0, "targetHours": 40.0 },
  "month": { "plannedHours": 120.0, "workedHours": 62.0, "creditedHours": 8.0, "targetHours": 160.0 },
  "timeAccount": { "balanceHours": 12.5 },
  "vacation": { "year": 2026, "remainingDays": 18.5, "pendingDays": 3.0, "usedDays": 8.5 },
  "pending": { "timeOffs": 1, "wishes": 2, "corrections": 0, "inquiriesAwaitingAnswer": 1 },
  "unread": { "notifications": 3, "inquiriesAnswered": 1 },
  "planPublishedUntil": [ { "hotelId": 1, "hotelName": "Frankfurt", "date": "2026-10-31" } ] }
```
**Plan for staff (C1):** `GET /schedules?employeeId=me&from&to` returns the employee's own published entries at all assigned hotels (`hotelId` optional). Without `employeeId` staff get the hotel plan under `portal.planVisibility`: `{ data:[ { date, department:{id,name}, shift:{name,startTime,endTime}, employee:{displayName}, isMine } ] }` (published shifts only).

**Profile (PR1/PR2):** `GET /me/profile` → `{ firstName, lastName, employeeNumber, employmentType, workWeekdays, homeHotel, hotels, departments, birthDate, phone, email, username, preferredLanguage }`; `PATCH /me/profile { phone?, preferredLanguage? }`. Name, e-mail, rate and hours come from managers.

**Notifications (NT1–NT5)**
```json
GET /notifications?unread=true&page=1
{ "data": [ { "id": 17, "kind": "roster_entry_changed", "params": { "date": "2026-10-06" }, "entityType": "schedule", "entityId": 123,
              "urgent": true, "createdAt": "...", "readAt": null } ], "meta": { "page": 1, "limit": 50, "total": 3, "unread": 3 } }
PATCH /notifications/17 { "read": true }          POST /notifications/read-all
GET /me/notification-preferences → { "roster_entry_changed": { "email": true }, ... }       PUT same shape
```

**Inquiries (IN1–IN5)**
```json
POST /inquiries { "subject": "Why was my break deducted?", "category": "attendance", "body": "...", "related": { "type": "time_entry", "id": 881 } }
201 { "id": 9, "status": "open", "hotelId": 1 }
GET /inquiries?status=open&page=1                 staff: own; managers: routed to their hotels
GET /inquiries/9 → { "id": 9, "subject": "...", "category": "attendance", "status": "answered", "related": { ... },
                     "employee": { "displayName": "Maria G." }, "assignedTo": { "displayName": "John M." },
                     "messages": [ { "id": 1, "author": { "displayName": "Maria G.", "role": "staff" }, "body": "...", "createdAt": "..." } ] }
POST /inquiries/9/messages { "body": "..." }     manager reply → answered; employee reply → open; on a closed inquiry → reopens
PATCH /inquiries/9 { "status": "closed" | "open", "assignedToId": 5 }       (assignment: manager only)
```

**Split shifts and minors (C3/C4/C5/C8):** a second shift on the same day returns `201` (with `split_shift_span` if the day's span exceeds `roster.maxDaySpanHours`); an overlap → `409 SHIFT_OVERLAPS_EXISTING`; more than `roster.maxShiftsPerDay` → `422 MAX_SHIFTS_PER_DAY_EXCEEDED`.
```json
422 { "error": { "code": "MINOR_PROTECTION_VIOLATION", "message": "...", "details": [
      { "rule": "daily_limit", "limit": 8.0, "actual": 9.0 }, { "rule": "latest_end", "limit": "22:00", "actual": "23:00" } ] } }
```
Rule names: `daily_limit`, `weekly_limit`, `days_per_week`, `shift_span`, `rest_period`, `earliest_start`, `latest_end`, `night_work`, `break`.

**Cover finder (C12)**
```json
GET /schedules/candidates?hotelId=1&date=2026-10-12&shiftId=3
{ "data": [ { "employee": { "id": 7, "displayName": "Maria G." }, "isFloating": false, "weeklyHoursSoFar": 24.0,
              "wish": "prefer", "warnings": [ ] } ] }
```

**Leave blackouts (B1–B3):** `POST /leave-blackouts { hotelId, startDate, endDate, reason, mode: "warn" | "block" }`; `GET /leave-blackouts?hotelId&year`. Time-off preview/create responses carry `warnings: [ { type: "leave_blackout", reason, mode } ]`; `block` → `422 LEAVE_BLACKOUT` for staff (managers send `overrideReason`).

**Payroll export (AT10/AT11)**
```
GET /hotels/1/payroll-export?month=2026-09&format=csv|json|datev
columns: employeeNumber, lastName, firstName, employmentType, payType, workedMinutes, plannedMinutes, creditedAnnualMinutes, creditedSickMinutes,
         creditedSchoolMinutes, creditedPublicHolidayMinutes, absenceDaysAnnual, absenceDaysSick, absenceDaysUnpaid, nightMinutes, saturdayMinutes, sundayMinutes, holidayMinutes,
         openOrReviewEntries, timeAccountDeltaMinutes
GET /attendance/export?hotelId&from&to&format=csv        one line per time entry: date, employeeNumber, shift, clockIn, clockOut, breakMinutes, workedMinutes, anomalies, status
```
`format=datev` returns `text/plain; charset=windows-1252` built from the templates in `payroll.datev` (R21). Illustration of the *shape only*; the real header, record description and line layout come from the sample your payroll office accepts:
```
[Bewegungsdaten]
10;12345;30.09.2026;162,50;1;<wageType worked>;;;"Import Stunden";
10;12345;30.09.2026;2,0;72;;;;"Import Krank";
```

### 8.2 Analytics definitions (N1–N6)
- **Attribution (floating staff):** absences, sick rate and headcount count under the employee's **home hotel**; roster hours, attendance and understaffing count under the hotel where the entry is.
- **Spell:** one approved sick-leave entry; entries on consecutive calendar days merge. **sickDays** = sum of counted-day fractions.
- **Bradford factor** = `spells² × sickDays` per employee (indicator for frequent short absences).
- **absenceRate** = `sickDays / (sickDays + scheduledShiftDays)`.
- **missingCertificates** = approved sick spells longer than `absence.sickNoteRequiredFromDay − 1` days without `medicalCertificateReceived`.
- **N1** `.../analytics/absences?from&to&departmentId` → `{ totals:{sickDays,spells,employeesAffected,absenceRate}, byEmployee:[{employeeId,name,department,sickDays,spells,bradfordFactor,missingCertificates}], byDepartment:[...] }`
- **N2** `.../absences/trend?from&to&granularity=month` → `{ series:[{period,sickDays,spells,absenceRate}] }`
- **N3** `.../analytics/hours?month=2026-10` → `{ byEmployee:[{employeeId,name,scheduledPaidHours,creditedHours,targetHours,delta,status}] }`
- **N4** `GET /audit-logs?hotelId&entityType&entityId&userId&action&from&to` (paginated) → `{ id, action, entityType, entityId, userId, before, after, meta, createdAt }`
- **N5** `.../analytics/attendance?from&to` → `{ byEmployee:[{employeeId,name,plannedPaidHours,actualPaidHours,lateCount,earlyLeaveCount,noShowCount,unscheduledCount,overtimeHours,openOrReviewEntries}], totals:{...} }`
- **N6** `GET /analytics/overview?hotelIds=1,2,3&from&to` (only hotels the caller may access) → `{ hotels:[{ hotelId, name, headcount, scheduledPaidHours, actualPaidHours, sickRate, understaffedShifts, openCorrections, needsReviewEntries, unpublishedDays }] }` (for regional managers and admins).

Analytics return aggregates and counts only; they never expose a diagnosis (none is stored).

---

## 9. Security, compliance and operations

**Security**
- Helmet, CORS allow-list, HTTPS only, secrets from environment, parameterized SQL only, request body limit 100 KB, `npm audit` in CI.
- Refresh-token rotation with reuse detection (reuse revokes the whole token family). Invite/reset/hand-over tokens: 256-bit, hashed, single-use, expiring. Browser clients: refresh token only in an httpOnly, Secure, SameSite=Strict cookie scoped to `/api/v1/auth`, access token in memory only, CSRF header + Origin check, CORS allow-list; users can list and revoke their sessions.
- Kiosk device tokens: 256-bit, hashed, revocable, optional IP allow-list; punch tokens: 60 s, single use. Kiosk endpoints can read nothing outside the roster/status they need.
- App DB role has no DDL rights; `audit_logs` is INSERT/SELECT only. No stack traces or SQL in error responses.
- Audited events (minimum): logins (success/failure), PIN failures/locks/resets, every create/update/delete/approve/reject on roster, absences, wishes, employees, targets, allowance, users, hotel settings, corrections, manual time entries, period locks, publish/unpublish, every warning override, anonymisations.

**Compliance notes (defaults, not legal advice: confirm with HR/legal and the works council)**
- **Law is changing:** as of October 2026 a reform of the Arbeitszeitgesetz is in draft (weekly instead of daily maximum, mandatory electronic recording of start/end/duration, two-year retention, possibly a sick note from day one); it is not law yet and a revised draft is expected this autumn. Hence `legal.limitMode`, `absence.sickNoteRequiredFromDay` and `retention` are settings, and attendance is part of this build.
- **Current rules used as defaults:** 11 h rest (§5; hospitality may shorten by 1 h with compensation, adjust `restPeriodMinHours` if applicable, unverified here), breaks 30/45 min (§4), 10 h daily maximum (§3).
- **GDPR/DSGVO:** sick leave is health data (Art. 9): no reasons stored, restricted reads, aggregated analytics, audit without personal data, anonymisation procedure, EU hosting. Set the retention period with payroll/legal (statutory periods for payroll records may be longer than the 3-year default).
- **Works council:** time recording and rostering/analytics tools are subject to co-determination (§87 BetrVG). Involve the Betriebsrat before go-live. The kiosk uses PIN only: no biometrics, photos or location (any of these needs a data-protection impact assessment first).
- **Minors and apprentices:** rules in R18 follow the JArbSchG as published by the Hessian labour ministry and chambers; confirm the exceptions (weekends, holidays, multi-shift operation) with legal/the chamber before relying on them. Birth date is personal data with restricted access. The default `warn` leaves the decision with the manager (reason required, audited); a breach can still be an administrative offence, so consider `block` once you know how often exceptions are really needed.
- **Employee portal:** colleagues' names and shifts are visible to staff per `portal.planVisibility`; agree the visibility and name format with the works council. Inquiry texts can contain personal data: no health details, no copies in e-mails or audit logs, limited retention.
- **Cross-hotel visibility:** managers of a non-home hotel see a floating employee's total hours and shifts at other hotels (hotel name + times) so that rest and hour limits can be respected; include this in the works-council briefing.
- **Integrity:** server time, no rounding, no overwriting, corrections with reasons, period lock: this is what makes the time records defensible.
- **Known risk:** PIN sharing ("buddy punching") on a shared tablet. Mitigations: PIN lockout, device IP allow-list, live board visible to managers, audit trail.

**Operations**
- `GET /health` (liveness) and `GET /ready` (DB reachable, migrations current).
- Structured JSON logs with `requestId`, user/device, route, status, duration.
- CI: install → lint → typecheck → migrate test DB → `npm test` → `npm audit`. Environments: local, staging, production, each with own DB/secrets; migrations run forward-only on deploy.
- Backups: daily + point-in-time recovery; restore test before go-live.
- `npm run seed` (never in production): 1 company, 2 hotels, 3 departments and Early/Late/Night shifts with breaks in the first hotel plus one department and shift in the second, 1 admin, 1 manager, 1 regional manager over 2 hotels, 6 employees with staff logins and PINs (one floating between both hotels, one 17-year-old apprentice, one username-only account), a paired demo device.

---

## 10. Testing strategy

Integration tests call the real HTTP API against a real Postgres test DB (reset per file). Unit tests cover pure functions (hours, instants/rest period incl. clock-change nights, week boundaries, counted days, vacation formulas, anomalies, Bradford factor, time account). A phase is done when its rows pass.

| # | Scenario | Expected |
|---|---|---|
| 1 | Login correct / wrong password | 200 tokens / 401 `INVALID_CREDENTIALS` |
| 2 | 10 wrong passwords | 423 `ACCOUNT_LOCKED` |
| 3 | Manager of hotel 1 reads a hotel 2 department | 404 |
| 4 | Regional manager (hotels 1,2): list with `hotelId=2` / `hotelId=3` / no `hotelId` | 200 / 404 / 400 |
| 5 | Invite → accept → login; reuse the token | works; 400 `TOKEN_INVALID` |
| 6 | Forgot-password for known vs unknown e-mail | identical 200 responses |
| 7 | Staff calls `POST /schedules` | 403 |
| 8 | Shift 22:00–06:00, break 60 | `durationHours` 8.0, `paidHours` 7.0 |
| 9 | Break ≥ duration | 400 |
| 10 | Delete department that has shifts | 409 `RESOURCE_IN_USE` |
| 11 | 8 h shift with 15 min break | 201 + `break_insufficient` |
| 12 | `workWeekdays` = `[0,9]` | 400 |
| 13 | Preview Mon–Fri with one public holiday | holiday in `skipped`, 4.0 days |
| 14 | Preview with half-day flags | 0.5 fractions on first/last day |
| 15 | Annual leave 28 Dec–3 Jan | accepted; usage split across both years |
| 16 | Annual leave needing more than remaining | 422 `ALLOWANCE_EXCEEDED` |
| 17 | Overlapping annual leave and unpaid leave | 409 `TIME_OFF_OVERLAP` |
| 18 | Sick leave inside approved vacation; then certificate received | 201; vacation `usedDays` drops by the overlap |
| 19 | Sick leave with a `reason` | 400 |
| 20 | Sick leave over existing roster entries (and with `unassignConflicts`) | 201 with `conflicts` (entries removed) |
| 21 | Approve annual leave then cancel | `usedDays` up then back |
| 22 | Staff cancels own pending / another employee's request | 200 / 404 |
| 23 | Assign shift of another department | 422 `EMPLOYEE_NOT_IN_DEPARTMENT` |
| 24 | Assign the same shift to the same employee twice on a date | 409 `EMPLOYEE_ALREADY_SCHEDULED` |
| 25 | Assign (shift or off) on an approved absence date | 422 `EMPLOYEE_ON_TIME_OFF` |
| 26 | Assign on a past date (hotel timezone) | 422 `SCHEDULE_DATE_IN_PAST` |
| 27 | Late 14–22, then Early 06–14 next day | 201 + `insufficient_rest_period` (8 h) |
| 28 | Night shift Mon, Early Tue 14:00 | gap correct across midnight |
| 29 | Night shift ending 25 Oct 2026 (clock change), then Early next day | gap uses real instants (3 h not 2 h of confusion), no off-by-one-hour |
| 30 | Push weekly paid hours above max | 201 + `exceeds_max_week` |
| 31 | Same request through `/schedules/validate` | 200, same warnings, nothing saved |
| 32 | Two parallel `POST /schedules` for the same employee/date | one 201, one 409 |
| 33 | `off` entry counts 0 hours | week/month totals unchanged |
| 34 | Bulk partial with 10 items, 2 invalid | 200: 8 created, 2 errors with codes |
| 35 | Copy week while one employee is on vacation | that employee skipped with reason |
| 36 | Publish; staff reads schedule before/after | staff sees only published |
| 37 | Absence approved after drafting, then publish | 409 `PUBLISH_CONFLICTS`, nothing published |
| 38 | Edit published shift 24 h before start | 200 + `short_notice_change` |
| 39 | Unpublish a past date | 422 |
| 40 | Save with warnings + `overrideReason` | stored and in audit `meta` |
| 41 | Pair device: valid / reused / expired code | token once / 400 / 400 `PAIRING_CODE_INVALID` |
| 42 | Revoke device, call again | 401 `DEVICE_UNAUTHORIZED` |
| 43 | Wrong PIN ×5 | 401 with `attemptsLeft`, then 423 `PIN_LOCKED` |
| 44 | Clock in; tablet sends a fake time | entry uses server time, fake time ignored |
| 45 | Reuse or let expire a `punchToken` | 401 `PUNCH_TOKEN_INVALID` |
| 46 | Clock in twice | 409 `INVALID_PUNCH_STATE` |
| 47 | Clock out in `auto` mode: 8 h shift / 4 h shift | break 30 / 0 |
| 48 | Clock in 45 min early | accepted, `early_clock_in`, timestamp unrounded |
| 49 | Unscheduled punch; punch during approved leave | `unscheduled_work`; `during_time_off` |
| 50 | Entry open 15 h → job; employee tries clock in | `needs_review`; 409 `ENTRY_NEEDS_REVIEW` |
| 51 | Staff requests correction (with/without reason); manager approves | 201/400; entry updated, original snapshot kept |
| 52 | Manager edits entry directly / staff edits directly | approved correction row created / 403 |
| 53 | Edit inside locked period: manager / admin with reason | 423 `PERIOD_LOCKED` / 200 |
| 54 | Live board: not-yet-arrived and clocked-in | correct lists and `minutesLate` |
| 55 | Time account with opening balance | delta and balance match hand calculation |
| 56 | Kiosk roster payload | only `displayName`, status, today's shift |
| 57 | Shift wish on scheduled date / on approved absence | 409 / 422 |
| 58 | Day-off wish (no shift); then assign a shift that day | accepted; `conflicts_with_wish` |
| 59 | Staff approves own wish | 403 |
| 60 | Planning dashboard without staffing requirements | `coverageRisk: null` |
| 61 | Sick analytics: 3 spells / 6 days | Bradford factor 54 |
| 62 | Update/delete on `audit_logs`; inspect audit rows | blocked; no PII keys present |
| 63 | Overview as regional manager | only accessible hotels |
| 64 | Anonymise terminated employee after retention | PII cleared; roster/time records/audit intact |
| 65 | Anonymise before retention (without / with `force` + reason) | 422 `RETENTION_NOT_ELAPSED` / 200 |
| 66 | Employee assigned to hotels 1 and 2 (home 1); manager of hotel 2 creates a shift entry at hotel 2 | 201 |
| 67 | Floating employee: shift 06–14 at hotel 1, then an overlapping shift at hotel 2 | 409 `SHIFT_OVERLAPS_EXISTING` |
| 68 | Manager of hotel 2 schedules an employee not assigned to hotel 2 (or unassigned before the date) | 422 `EMPLOYEE_NOT_ASSIGNED_TO_HOTEL` |
| 69 | Late shift at hotel 1, Early shift next day at hotel 2 | 201 + `insufficient_rest_period` with `hotelName`; weekly totals count both hotels |
| 70 | Home manager approves annual leave; hotel 2 manager schedules that day / reads the absence | 422 `EMPLOYEE_ON_TIME_OFF` / only `unavailable`, no type |
| 71 | Hotel 2 manager reads the floating employee / edits master data / looks for `hourlyRate` | 200 reduced view / 403 / field absent |
| 72 | Remove the employee from hotel 2 while future entries exist; then after deleting them | 409 `RESOURCE_IN_USE`; 200 and history still readable |
| 73 | Kiosk at hotel 2: assigned employee uses the same PIN / employee not assigned there | 200 / 401 generic `INVALID_PIN` |
| 74 | Open entry at hotel 1, then punch at hotel 2 / punch at hotel 2 while rostered at hotel 1 | 409 `INVALID_PUNCH_STATE` / accepted with `scheduled_elsewhere` |
| 75 | Overview and analytics for a floating employee | absence and headcount counted once (home hotel); hours counted at the hotel worked |
| 76 | Home manager approves sick leave over the employee's entries at hotel 2 with `unassignConflicts` | entries removed at both hotels, audited |
| 77 | Breakfast 06–10 and Dinner 17–21 on the same day for one employee | both 201; second carries `split_shift_span` |
| 78 | Shift overlapping another shift of the day (06–14 and 10–18) | 409 `SHIFT_OVERLAPS_EXISTING` |
| 79 | Night shift Mon 22–06, then a 05:00 shift Tue / a 06:00 shift Tue | 409 `SHIFT_OVERLAPS_EXISTING` / 201 |
| 80 | A third shift on a day with `maxShiftsPerDay = 2` | 422 `MAX_SHIFTS_PER_DAY_EXCEEDED` |
| 81 | Day off on a day with a shift, and a shift on a day off | 409 `EMPLOYEE_ALREADY_SCHEDULED` both ways |
| 82 | Split day: rest check and daily maximum | no `insufficient_rest_period` between parts; daily maximum uses the day total |
| 83 | Move a shift (PATCH) into an overlap | 409 `SHIFT_OVERLAPS_EXISTING` |
| 84 | 17-year-old, 9 h shift: default `warn` with / without `overrideReason`; hotel set to `block` | 201 + `minor_protection` (`daily_limit`) / 422 `OVERRIDE_REASON_REQUIRED` / 422 `MINOR_PROTECTION_VIOLATION` |
| 85 | Shift ending 21:00 for a 16-year-old / a 15-year-old | allowed / `minor_protection` (`latest_end`) |
| 86 | Minor with 36 h rostered plus a school day | `minor_protection` (`weekly_limit`, school credit counted) |
| 87 | Minor: 10 h between shifts of two days | `minor_protection` (`rest_period`) |
| 88 | Minor: night shift crossing midnight | `minor_protection` (`night_work`) |
| 89 | Minor: sixth working day in a week | `minor_protection` (`days_per_week`) |
| 90 | Minor: 7 h shift with 30 min break | `minor_protection` (`break`) |
| 91 | Apprentice: `school` days block the roster and credit hours | 422 `EMPLOYEE_ON_TIME_OFF`; credit equals a normal day |
| 92 | Employee turns 18 during the week | adult rules from the birthday |
| 93 | Create an employee born less than 15 years ago | 400 `VALIDATION_ERROR` |
| 94 | Vacation allowance of a 16-year-old below the statutory minimum | 200 + `below_statutory_minimum` |
| 95 | Staff without e-mail: manager issues a hand-over link, employee sets a password, logs in with the username | 200 |
| 96 | Duplicate username (any case) / no e-mail and no username | 409 `DUPLICATE_RESOURCE` / 400 |
| 97 | Manager issues a reset link for an e-mail-less account; use it | old sessions revoked |
| 98 | Web login: cookie flags, body without refresh token; refresh without CSRF header / with it / replaying an old cookie | cookie set; 403 `CSRF_REJECTED` / 200 rotated / whole family revoked |
| 99 | List own sessions, revoke one, refresh with it | revoked session cannot refresh |
| 100 | Staff reads own work summary / another employee's | 200 / 404 |
| 101 | Staff lists shift and leave wishes | only own wishes |
| 102 | Plan with `own_departments`: staff view | colleagues of own departments as "Maria G.", shifts only, no drafts, no other departments |
| 103 | Dashboard numbers vs the underlying endpoints | identical |
| 104 | Staff patches phone/language / name or rate | 200 / ignored or 403 |
| 105 | Publish a week; edit a published entry inside the notice window; mark read; e-mail preference | one `roster_published` per employee; `roster_entry_changed` urgent; e-mail only if enabled and address exists |
| 106 | Terminate an employee | user disabled, sessions revoked, PIN invalid on the kiosk |
| 107 | Staff opens an inquiry (home hotel, and about an entry at hotel 2) | routed to home hotel managers / hotel 2 managers only |
| 108 | Manager replies, employee replies, employee closes, new message | `answered` → `open` → `closed` → reopened; notifications created |
| 109 | Other employee / manager of another hotel reads the inquiry | 404 |
| 110 | Empty or over-long body; 21st inquiry in a day | 400 / 429 |
| 111 | Cover finder for a 06:00 shift | excludes absent, overlapping, wrong department, minor-violating; includes floating; `prefer` first |
| 112 | Payroll export for a sample month | totals match entries and absences; night/Sunday/holiday minutes; open entries counted separately |
| 113 | Leave request over a `warn` / `block` blackout | 201 + warning / 422 `LEAVE_BLACKOUT` (manager with `overrideReason` 201) |
| 114 | Staff wish inside `minLeadDays` / manager on behalf | 422 `WISH_DEADLINE_PASSED` / 201 |
| 115 | Floating employee's vacation across a holiday that exists only in the other hotel's region | counted with the home hotel's calendar |
| 116 | DATEV export for a sample month; wage type unmapped; employee without personnel number | file equals the golden file approved by the payroll office; 422 `PAYROLL_MAPPING_INCOMPLETE`; 422 `VALIDATION_ERROR` |
| 117 | Bulk assign with a minor warning: one item with, one without `overrideReason` | created / that item `OVERRIDE_REASON_REQUIRED` |

---

## 11. Folder structure

```
backend/
├── package.json  tsconfig.json  .env.example  docker-compose.yml  openapi.yaml
├── migrations/            0001_init.sql (Appendix A)
├── src/
│   ├── server.ts  app.ts  config.ts
│   ├── middleware/        auth  deviceAuth  requireRole  hotelScope  validate  rateLimit  requestId  etag  errorHandler
│   ├── routes/            auth  admin  users  departments  shifts  employees  timeOffs  schedules  kiosk  attendance  wishes  portal  inquiries  notifications  blackouts  exports  analytics  audit  health
│   ├── controllers/       thin: parse → service → respond
│   ├── services/          AuthService  InviteService  ScheduleService  BulkScheduleService  RosterPublishService
│   │                      WorkingHoursService  RestPeriodService  TimeOffService  AllowanceService  HolidayService
│   │                      WishService  CoverageService  KioskService  PinService  AttendanceService
│   │                      TimeAccountService  AnalyticsService  AuditService  RetentionService  MailerService
│   │                      SessionService  PortalService  InquiryService  NotificationService  MinorRulesService
│   │                      CandidateService  PayrollExportService
│   ├── repositories/      one per table; only place with SQL and snake↔camel mapping
│   ├── validators/        zod schemas per endpoint + hotel settings schema
│   ├── domain/            pure functions: hours  instants  restPeriod  daySpan  weeks  timeOffDays  vacation  anomalies  timeAccount  bradford  minorRules  warnings
│   ├── jobs/              needsReview (hourly)  notificationMailer (every minute)  tokenCleanup, inquiryRetention, disableTerminatedUsers (daily)  withAdvisoryLock
│   ├── errors/            AppError + error catalog (Appendix B)
│   └── db/                pool  tx (withTransaction)  errorMap (constraint → AppError)
├── scripts/               seed.ts
└── tests/                 unit/  integration/  helpers/
```

Rule: business rules live in `services/` and `domain/`; controllers hold no logic; repositories hold no business rules.

---

## 12. Naming reference (JSON, camelCase)

- **Employee:** id, employeeNumber, firstName, lastName, email, phone, hourlyRate, payType (`salary`|`hourly`), publicHolidaysOff, status, employmentType, birthDate, hiredOn, attendanceRequired, workWeekdays[1–7], terminatedOn, homeHotelId, hotels[{id,name,isHome}], departments[{id,name,color,hotelId}], hotelIds[] and departmentIds[] (input)
- **Shift:** id, hotelId, departmentId, name, startTime, endTime, durationHours, breakDurationMinutes, paidHours, warnings[]
- **Work targets:** targetHoursPerWeek, minHoursPerWeek, maxHoursPerWeek, targetHoursPerMonth, minHoursPerMonth, maxHoursPerMonth, openingBalanceHours, balanceStartDate
- **Allowance:** year, vacationDaysPerYear, carriedOverDays, carryOverExpiresOn, usedDays, pendingDays, remainingDays
- **Time-off:** id, employeeId, type, startDate, endDate, startHalfDay, endHalfDay, timeOffDays (computed), reason, status, medicalCertificateReceived, decidedById, decidedAt, conflicts[]
- **Roster entry:** id, status (`draft`|`published`), entryType (`shift`|`off`), employee, shift, offLabel, date, paidHoursAssigned, currentWeekHours, currentMonthHours, weeklyTarget, monthlyTarget, restPeriodHours, warnings[], overrideReason, publishedAt
- **Warning/anomaly:** type, severity (`warning`|`info`), message, plus context
- **Time entry:** id, employeeId, scheduleId, status (`open`|`closed`|`needs_review`), clockInAt, clockOutAt, breakMinutes, workedMinutes, sourceIn, sourceOut (`kiosk`|`manager`|`system`), anomalies[], note, corrections[]
- **Correction:** id, timeEntryId, proposedClockInAt, proposedClockOutAt, proposedBreakMinutes, reason, status, decisionNote
- **Kiosk device:** id, name, status (`active`|`revoked`), lastSeenAt
- **Shift wish:** id, employeeId, date, shiftId|null, kind (`prefer`|`avoid`), priority (1 high–3 low), reason, status, decisionNote
- **Leave wish:** id, employeeId, startDate, endDate, leaveDays, priority, reason, status, decisionNote
- **User:** id, email, username, role, status (`invited`|`active`|`disabled`), employeeId, hotelIds[], preferredLanguage
- **Inquiry:** id, employee, hotelId, subject, category, status (`open`|`answered`|`closed`), related{type,id}, assignedTo, messages[{id,author,body,createdAt}]
- **Notification:** id, kind, params, entityType, entityId, urgent, createdAt, readAt
- **Leave blackout:** id, hotelId, startDate, endDate, reason, mode (`warn`|`block`)
- **Enums:** time-off `type` = annual_leave | sick_leave | unpaid_leave | school | other; employmentType = full_time | part_time | mini_job | working_student | apprentice | intern | other; `status` (absences, wishes, corrections) = pending | approved | rejected | cancelled; role = staff | manager | admin; employee status = active | on_leave | terminated; kiosk action = clock_in | clock_out | break_start | break_end

---

## 13. Build phases (give Claude Code one at a time)

Each phase ends with migrations applied, endpoints implemented, listed tests green, OpenAPI updated, one commit. **Minimum for a first hotel go-live (managers + tablet): Phases 0–6. Employee go-live adds Phases 7–8.**

| Phase | Build | Done when |
|---|---|---|
| 0 | Repo, docker-compose, config, pool, migration `0001_init`, error handler, requestId, logging, health/ready, test harness, seed skeleton | `npm test` runs, `/ready` 200 |
| 1 | Auth incl. invite/forgot/reset, username logins, hand-over/reset links, browser cookie auth, sessions (A1–A11, U7), users, companies, hotels, settings, hotel-access, role/hotel-scope middleware, rate limits, mailer, audit service | Tests 1–7, 95–99 |
| 2 | Departments, shifts (break warnings), staffing requirements | Tests 8–11 |
| 3 | Employees (company-level, workWeekdays), hotel assignments incl. floating staff (E12), department assignment, work targets, public holidays | Tests 12, 71, 93 |
| 4 | Time-offs: preview, create, approve/cancel, `school` type, blackouts, per-day expansion with home-hotel holidays, allowance + view, sick rules, conflicts | Tests 13–22, 94, 113, 115 |
| 5 | Roster: validate, create (shift/off, split shifts, overlap checks), minor protection rules, cover finder, update, delete, list, coverage, bulk, copy, publish/unpublish, rest period with real instants, cross-hotel totals and checks, warnings, transactions, work-summary | Tests 23–40, 66–70, 72, 76–92, 111, 117 |
| 6 | Attendance: kiosk pairing/roster/verify/punch, PINs, entries, anomalies, breaks, corrections, live board, period lock, needs-review job, time account, payroll (generic and DATEV LODAS) and attendance export | Tests 41–56, 73, 74, 106, 112, 116 |
| 7 | Wishes (incl. day-off wish, lead time) and planning dashboard | Tests 57–60, 114 |
| 8 | Employee portal: dashboard, plan for staff, profile, notifications and e-mail job, inquiries, own-data endpoints | Tests 100–105, 107–110 |
| 9 | Analytics N1–N6 and audit endpoint | Tests 61–63, 75 |
| 10 | Anonymisation, retention, token cleanup, load test, security review, backup/restore drill | Tests 64–65 |

**Prompt template for each phase:**
> Read `docs/SPEC.md` sections 1, 2, 4–7, the rows of section 8 for this phase, the matching payloads in 8.1, section 10, section 12, Appendix A and B. Implement Phase N only: <row from the table>. Use exact field names, error codes and status codes. Write the listed tests first, then the code. Do not touch other phases. Run `npm test` and show me the result.

---

## 14. Roadmap (not in v2.3)

1. Announcements/news board; web push and SMS notifications.
2. Sunday/holiday work rules and compensation days (ArbZG §§9–11); shift swaps and open-shift pool.
3. More than the default two shifts per day; on-call duty (Bereitschaft).
4. Badge/QR identification, personal-device clock-in, geofencing (works-council and DPIA decisions needed first).
5. Printable/PDF roster, native mobile app, SSO, two-factor authentication for managers, DATEV Lohn und Gehalt (LuG) import if the payroll office uses it instead of LODAS.
6. Mini-job earnings-limit warning, medical check-up tracking for minors, enforcement (not just warnings) of weekend/holiday rules for minors, employee self-service data export (GDPR Art. 15), e-mail change with verification, Bradford-factor alerts and absence-pattern reports.

## 15. Open decisions (defaults applied, change before Phase 0)

| # | Question | Default |
|---|---|---|
| O1 | Break handling on the tablet | **Confirmed:** `auto` (scheduled break deducted); `recorded` stays available as a setting |
| O2 | Employee identification on the tablet | **Confirmed:** name + 6-digit PIN only |
| O3 | One employee in several hotels? | **Confirmed:** yes, floating staff (built into v2.2) |
| O4 | Time-record retention | 3 years (confirm with payroll/legal) |
| O5 | Sick-leave hours credit limit | 42 days |
| O6 | TypeScript or JavaScript | TypeScript |
| O7 | Raw SQL or an ORM | Raw SQL |
| O8 | Real Trip Inn Frankfurt departments and shift times for seed data | Needed from you |
| O9 | Hosting (EU region) | Not chosen |
| O10 | Minors' protection rules: block or warn | **Confirmed: warn**, manager decides, written reason required; `block` available per hotel (R18) |
| O11 | What staff see of the hotel plan | **Confirmed: own departments**, names as "Maria G." (`portal.*`) |
| O12 | Payroll export format | **Confirmed: DATEV Lohn** (LODAS ASCII import assumed, template-driven); generic CSV/JSON also available |
| O13 | Portal languages | German + English |
| O14 | Who answers employee questions | all managers with access to the routed hotel |
| O15 | Shifts per employee per day | at most 2 (split shifts are rare) |
| O16 | Which DATEV payroll product does the payroll office use, and what import file does it accept? | **Product confirmed: LODAS.** Still open: payroll is prepared by an external office; product unknown. Ask the office for a sample import file, consultant/client numbers and wage-type numbers (draft e-mail provided). The export is the last item of Phase 6 and does not block the rest |

---

## Appendix B: Error codes

| Code | HTTP | Meaning |
|---|---|---|
| VALIDATION_ERROR | 400 | Schema/shape validation failed (`details[]`) |
| TOKEN_INVALID | 400 | Invite/reset token unknown, used or expired |
| PAIRING_CODE_INVALID | 400 | Kiosk pairing code unknown, used or expired |
| UNAUTHENTICATED / TOKEN_EXPIRED / INVALID_CREDENTIALS | 401 | Missing/expired token; wrong login |
| DEVICE_UNAUTHORIZED | 401 | Missing, unknown or revoked device token |
| INVALID_PIN | 401 | Wrong PIN (`attemptsLeft`) |
| PUNCH_TOKEN_INVALID | 401 | Punch token expired or already used |
| FORBIDDEN | 403 | Role not allowed |
| CSRF_REJECTED | 403 | Browser refresh/logout without the CSRF header or an allowed Origin |
| RESOURCE_NOT_FOUND | 404 | Missing, or belongs to another hotel/company |
| EMPLOYEE_ALREADY_SCHEDULED | 409 | Same shift again, or a day off meets another entry |
| SHIFT_OVERLAPS_EXISTING | 409 | Overlap with another shift of the employee (any hotel) |
| DUPLICATE_RESOURCE | 409 | Unique name/e-mail |
| RESOURCE_IN_USE | 409 | Delete blocked by dependants |
| TIME_OFF_OVERLAP | 409 | Absence/leave-wish overlap |
| TIME_OFF_CONFLICTS_WITH_SCHEDULE | 409 | Absence covers roster entries (R6) |
| PUBLISH_CONFLICTS | 409 | Drafts violate hard blocks at publish (R12) |
| BULK_FAILED | 409 | Atomic bulk had errors |
| INVALID_PUNCH_STATE | 409 | Punch not allowed in current state |
| ENTRY_NEEDS_REVIEW | 409 | Open entry waiting for a manager |
| TIME_ENTRY_OVERLAP | 409 | Manual entry overlaps another entry |
| PRECONDITION_FAILED | 412 | `If-Match` mismatch |
| EMPLOYEE_ON_TIME_OFF | 422 | R2 |
| EMPLOYEE_NOT_IN_DEPARTMENT | 422 | R2 |
| EMPLOYEE_INACTIVE | 422 | R2 |
| MAX_SHIFTS_PER_DAY_EXCEEDED | 422 | R2 |
| MINOR_PROTECTION_VIOLATION | 422 | R18 (`details[].rule`) |
| LEAVE_BLACKOUT | 422 | R22 |
| WISH_DEADLINE_PASSED | 422 | R10 |
| OVERRIDE_REASON_REQUIRED | 422 | R18 (minor warning saved without `overrideReason`) |
| UNPLANNED_REASON_REQUIRED | 422 | 1.12 (clock-in without a planned shift and without a reason) |
| PAYROLL_MAPPING_INCOMPLETE | 422 | R21 (DATEV consultant/client number, templates or wage types missing) |
| EMPLOYEE_NOT_ASSIGNED_TO_HOTEL | 422 | R2 (DB trigger message "not assigned to this hotel" maps here) |
| SCHEDULE_DATE_IN_PAST | 422 | R2 |
| ALLOWANCE_EXCEEDED | 422 | R9 |
| NO_WORKING_DAYS_IN_RANGE | 422 | R8 |
| INVALID_STATUS_TRANSITION | 422 | e.g. rejected → approved |
| RANGE_TOO_LARGE | 422 | Range over 62 days |
| RETENTION_NOT_ELAPSED | 422 | Anonymise before retention without `force` |
| ACCOUNT_LOCKED / PIN_LOCKED / PERIOD_LOCKED | 423 | Login/PIN lockout; payroll period locked |
| RATE_LIMITED | 429 | Too many requests |
| INTERNAL_ERROR | 500 | Unexpected; details only in logs |

**DB error mapping (`db/errorMap.ts`):** `23505` unique → by constraint name (`uq_schedule_same_shift`, `uq_schedule_one_off` → EMPLOYEE_ALREADY_SCHEDULED; `uq_users_username`, `uq_users_email`, `uq_employees_number` and other `uq_*` → DUPLICATE_RESOURCE); `23P01` exclusion → `no_overlapping_time_offs`/`no_overlapping_sick_leave`/`no_overlapping_leave_wishes` → TIME_OFF_OVERLAP, `no_overlapping_time_entries` → INVALID_PUNCH_STATE (kiosk) or TIME_ENTRY_OVERLAP (manual); `23514` check: message "does not work in this shift's department" → EMPLOYEE_NOT_IN_DEPARTMENT, message "not assigned to this hotel" → EMPLOYEE_NOT_ASSIGNED_TO_HOTEL, message "Shift overlaps another shift" → SHIFT_OVERLAPS_EXISTING, message "Day off cannot coexist" → EMPLOYEE_ALREADY_SCHEDULED, `chk_*`/other → VALIDATION_ERROR; `23503` foreign key → RESOURCE_NOT_FOUND.

---

## Appendix A: Database schema (migration `0001_init`)

Verified on PostgreSQL 16. Needs the `btree_gist` extension (standard contrib; allowed on major managed providers).

The DDL is kept verbatim in [`backend/migrations/0001_init.sql`](../backend/migrations/0001_init.sql) (the file *is* Appendix A; never edit it once applied — add a new migration instead).
