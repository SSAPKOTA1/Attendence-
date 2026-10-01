# Frontend Implementation Plan: Trip Inn Attendance & Roster

## 1. Overview

Three interconnected React apps built from the Claude Design mockup, powered by the 122-endpoint OpenAPI backend:

| App | Role | Users | Key Features |
|-----|------|-------|---|
| **Manager Dashboard** | M+ | Hotel managers, admins | Roster, live board, requests, staff, analytics |
| **Kiosk/Tablet** | Device token | Shared tablet | PIN verification, punch clock, shift info |
| **Employee Portal** | S+ | All staff | Schedule, time-off, requests, time account, profile |

## 2. Tech Stack

**Frontend:**
- React 18+ (TypeScript)
- TanStack Router (v1, type-safe routing)
- TanStack Query (data fetching, caching, real-time)
- Zustand (auth state, settings)
- Date-fns + Luxon (timezone-aware dates)
- OpenAPI TypeScript client (auto-generated from backend `openapi.yaml`)
- Vite (build)
- Tailwind CSS + design tokens (from mockup)

**Deployment:**
- Single repository, three separate SPA entry points
- Shared `@attendence/ui` component library (design system)
- Shared `@attendence/api` (generated TS client + hooks)
- Monorepo: `apps/dashboard`, `apps/kiosk`, `apps/portal`

**Auth:**
- HTTP-only refresh cookie (via CORS credentials)
- Access JWT in memory (15 min)
- Per-app logout + session management
- Rate-limit handling (retry with backoff)

## 3. Architecture

### 3.1 Shared (`packages/`)

```
packages/
  ui/                          # Design system component library
    src/
      components/              # Button, Input, Dialog, Table, etc. (from mockup)
      hooks/                   # useMediaQuery, useToast, useConfirm, etc.
      theme/                   # Tailwind config + CSS custom properties (design tokens)
      
  api/                         # OpenAPI TypeScript client + hooks
    src/
      client/                  # Generated from backend openapi.yaml
      hooks/
        useAuth.ts             # login, logout, refresh, me
        useEmployees.ts        # list, get, create, update, delete
        useRoster.ts           # schedules, publish, validate, bulk, copy
        useAttendance.ts       # entries, corrections, approval, live board
        useTimeOffs.ts         # absences, allowance, vacation
        useAnalytics.ts        # overview, team, employee, audit
        useNotifications.ts    # list, mark read, subscribe to WebSocket
        
  auth/                        # Auth context + utilities
    src/
      AuthContext.tsx
      useAuth.ts               # Hook to read/modify auth state
      tokens.ts                # JWT decode, expiry check
      api.ts                   # Axios instance with auth interceptors
```

### 3.2 Apps

```
apps/
  dashboard/                   # Manager Dashboard (M+)
    src/
      pages/
        Roster.tsx             # Weekly view, drag-drop shifts, publish
        Staff.tsx              # Employee list, assign hotels, edit
        Live.tsx               # Real-time board, arrivals, no-shows
        Requests.tsx           # Approve/reject absences, wishes, corrections
        Analytics.tsx          # Overview, team, audit, payroll export
        Settings.tsx           # Hotel settings, users, devices, blackouts
      components/
        RosterWeek.tsx         # Week navigation, day columns, shifts
        EmployeeRow.tsx        # Assigned shifts + conflicts
        LiveBoard.tsx          # Real-time status + actions
        RequestsList.tsx       # Pending items by type
        
  kiosk/                       # Tablet Punch Clock (Device Token)
    src/
      pages/
        PairingCode.tsx        # Device pairing (manager-generated code)
        PinEntry.tsx           # 6-digit PIN entry with numpad
        VerifyResult.tsx       # "Allowed: clock_in / clock_out / blocked"
        PunchClock.tsx         # Shift info, reason input (if unplanned), action buttons
        Feedback.tsx           # Success/error feedback (5 s)
      components/
        Numpad.tsx             # Number pad + clear + submit
        ShiftCard.tsx          # Upcoming shift details
        AnomalyWarning.tsx     # Early clock-in, overtime, minor alerts
        
  portal/                      # Employee Portal (S+)
    src/
      pages/
        Dashboard.tsx          # Today, this week, time account, vacation
        Schedule.tsx           # Published roster, my shifts
        TimeOffs.tsx           # Vacation, sick, requests, allowance
        Attendance.tsx         # Time entries, corrections
        Profile.tsx            # Name, email, phone, language, PIN reset
        Questions.tsx          # Ask manager, replies, history
        Notifications.tsx      # Alerts, decisions, messages
      components/
        ShiftCard.tsx          # Shift details (name, times, break, hotel)
        TimeOffForm.tsx        # Request vacation/sick with preview
        TimeAccountChart.tsx   # Visual representation + balance
```

## 4. Build Order (Phases)

### Phase 1: Setup & Shared (1–2 weeks)
- [ ] Monorepo (pnpm workspaces or similar)
- [ ] Design system extraction (`packages/ui`, Tailwind + CSS tokens)
- [ ] OpenAPI TypeScript client generation (`packages/api`)
- [ ] Auth context + interceptors (`packages/auth`)
- [ ] Vite config for three apps
- [ ] CI/CD setup (lint, typecheck, test, build)

### Phase 2: Login & Auth (1 week)
- [ ] Login page (email/username + password)
- [ ] Forgot password / reset password flow
- [ ] Session management (refresh, logout-all)
- [ ] Auth guard (redirect to login if not authenticated)
- [ ] Profile page (name, email, phone, language preference, PIN reset)

### Phase 3: Manager Dashboard (4–5 weeks)
- [ ] **Roster** (3 weeks)
  - Week navigation, day columns
  - Drag-drop shift assignment
  - Conflicts + warnings display
  - Publish/unpublish
  - Bulk assign, copy week
  - Print/PDF export
- [ ] **Live Board** (1 week)
  - Real-time arrivals, no-shows, expected not arrived
  - Clock-in/out actions
  - Corrections modal
- [ ] **Staff** (1 week)
  - Employee list (filter by dept, hotel, status)
  - Create/edit/delete (admin only)
  - Assign to hotels
  - Vacation allowance edit
- [ ] **Requests** (1 week)
  - Absences (approve/reject)
  - Wishes (day-off, shift)
  - Corrections (clock times)
  - Sick reports
  - Inquiries (Q&A routing)
- [ ] **Analytics** (1 week)
  - Overview (hours, overtime, sick days by hotel)
  - Team stats (per employee)
  - Audit log viewer
  - Payroll export (CSV, JSON, DATEV)

### Phase 4: Kiosk/Tablet (2 weeks)
- [ ] Pairing code entry (manager generates on dashboard)
- [ ] PIN entry (6-digit numpad, case-insensitive)
- [ ] Verify response (allowed actions, reason required?)
- [ ] Punch clock (clock-in/out with shift info)
- [ ] Reason input (if unplanned shift)
- [ ] Anomaly warnings (early, late, overtime, minor restrictions)
- [ ] Success/error feedback
- [ ] Responsive: iPad landscape (primary), mobile fallback

### Phase 5: Employee Portal (3 weeks)
- [ ] **Dashboard** (1 week)
  - Today's card (shift, time account balance, vacation left)
  - This week (shift cards)
  - Upcoming notifications
- [ ] **Schedule** (1 week)
  - Published roster
  - Filter by date range, department
  - Shift details (name, times, hotel, break)
  - iCal export
- [ ] **Time-Offs** (1 week)
  - Request vacation/sick (date range, half-day, reason for sick)
  - Preview (conflicts, allowance check)
  - Allowance view (per year, carry-over, used, pending, remaining)
  - Blackout warnings
- [ ] **Attendance** (1 week)
  - Time entries (today, range)
  - Request correction
  - Approval status (if unplanned)
- [ ] **Questions** (1 week)
  - Ask manager (category, message)
  - View replies
  - History

### Phase 6: Polish & Testing (2 weeks)
- [ ] E2E tests (Playwright): login → roster → publish → kiosk → portal flows
- [ ] Accessibility (WCAG 2.1 AA): labels, keyboard nav, screen readers
- [ ] i18n (de, en) via i18next
- [ ] Performance (bundle size, Core Web Vitals)
- [ ] Error handling + retry logic
- [ ] Loading states + skeletons
- [ ] Offline mode (service worker, cache strategy)

### Phase 7: Deployment & Ops (1 week)
- [ ] Docker multi-stage builds (dashboard, kiosk, portal)
- [ ] Nginx routing (`/dashboard`, `/kiosk`, `/portal` → SPA entry points)
- [ ] S3 + CloudFront for static assets
- [ ] Environment config (API base URL, features, analytics)
- [ ] Health checks, error logging (Sentry)
- [ ] Documentation (dev setup, deployment, troubleshooting)

## 5. Estimated Effort

| Phase | Duration | Notes |
|-------|----------|-------|
| 1. Setup & Shared | 10–14 days | Blocking on other phases |
| 2. Login & Auth | 5–7 days | Quick win, validates backend integration |
| 3. Dashboard | 20–25 days | Largest phase; roster is complex (drag-drop, conflicts) |
| 4. Kiosk | 10–14 days | Simpler, but responsive + anomaly logic |
| 5. Portal | 15–20 days | Medium complexity, feature-rich |
| 6. Polish & Testing | 10–14 days | E2E, accessibility, i18n |
| 7. Deployment | 5–7 days | CI/CD, infrastructure |
| **Total** | **75–101 days** | ~3.5–5 months; can parallelize phases 3–5 after phase 1–2 |

## 6. Key Design Decisions

### 6.1 Monorepo vs. Separate Repos
**Decision:** Monorepo (pnpm workspaces)
- Shared UI + API packages
- Consistent styling, component versioning
- Easier refactoring
- One CI/CD pipeline

### 6.2 State Management
**Decision:** Zustand (auth) + TanStack Query (server state)
- Zustand: minimal, auth state (user, tokens, permissions)
- TanStack Query: roster, employees, attendance data (cache, sync, refetch)
- No Redux or MobX overhead

### 6.3 Routing
**Decision:** TanStack Router (type-safe, lazy code-splitting)
- Protected routes by role (middleware)
- Deep linking (e.g., `/dashboard/roster?week=2026-10-01`)
- Search params for filters, pagination

### 6.4 Real-Time Updates
**Decision:** TanStack Query + WebSocket (optional)
- Polling (5–10 s) for live board, notifications (default)
- WebSocket for real-time (future, if latency critical)
- Fallback to polling if WebSocket unavailable

### 6.5 Kiosk Security
**Decision:** Device token (no user session)
- Pairing code (one-time use, 15 min validity)
- PIN as second factor (6-digit, timing-safe check on backend)
- No login; device is trusted
- Disable on dashboard after unpair

## 7. Open Questions / Decisions Needed

1. **Dark mode:** Design supports light; add dark mode with `prefers-color-scheme`?
2. **Translations:** German + English only, or more languages?
3. **Offline:** Can kiosk work offline (punch clock stored locally, synced later)?
4. **Mobile manager:** Should dashboard be mobile-responsive, or desktop-only?
5. **Realtime notifications:** WebSocket or polling is fine?
6. **Analytics:** Grafana/Kibana dashboards, or in-app charts only?

## 8. Success Criteria

- ✅ All 122 endpoints used correctly
- ✅ Auth flow (login, refresh, logout) working
- ✅ Manager can roster a week and publish
- ✅ Tablet can punch in/out (demo PIN: any except 000000)
- ✅ Employee sees personal schedule and can request vacation
- ✅ No console errors, performance > 90 Lighthouse
- ✅ i18n (de, en) fully translated
- ✅ E2E tests pass (5 main flows)
