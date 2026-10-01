# Frontend

One single-page app (`frontend/`): React 18 + TypeScript, Vite, React Router, TanStack Query. The look comes from the Claude Design
mockup *Trip Inn Attendance* ("Modernist" tokens and component classes, extracted unchanged into `src/styles/design-system.css`;
app-specific layout lives in `src/styles/app.css`). No UI framework, no CSS-in-JS. The backend is untouched.

> This replaces the earlier plan that proposed three separate apps and a monorepo. One bundle with three route areas is simpler to
> build, test and deploy, and every area shares the same auth, API client and i18n. Code-splitting keeps each area's JS small
> (main chunk 79 kB gzipped).

## Areas

| Area | Route | Who | Screens |
|---|---|---|---|
| Sign-in | `/login`, `/forgot-password`, `/reset-password`, `/accept-invite` | everyone | login, reset, invite activation |
| Tablet (kiosk) | `/kiosk` | shared device (device token, no user) | pairing code, who is due / name search, PIN pad, clock in/out/break, reason for unplanned work, server clock |
| Employee portal | `/portal/*`, `/notifications`, `/profile` | everyone with an employee record | dashboard, own roster (+ colleagues per plan visibility), vacation request with preview and balance, wishes, own times and correction requests, questions, notifications, profile (language, PIN, password, sessions, e-mail settings) |
| Manager dashboard | `/manage/*` | manager, admin | roster week grid (draft/publish/copy/print, rule checks, cover finder), live board, requests (absences, corrections, wishes, unplanned time approval), staff (onboarding, vacation balance and carry-over, targets, time account, PIN, hotels), time entries (manual/corrections), analytics, tablets/period lock/payroll export, setup (shifts, staffing, departments, users and invite links, leave blackouts, audit log) |

Role rules mirror the API (the API stays the authority): shifts are designed by admins only, employees are added/deleted by admins only,
managers see only their hotels, floating staff show a reduced view.

## How it talks to the API

- `src/lib/api.ts`: `fetch` wrapper for `/api/v1`. Access token only in memory; the refresh token is the HttpOnly cookie (`X-Client: web`,
  `X-Requested-With`). One shared refresh when the token expires (single-flight), then the request is retried once; a failed refresh ends the session.
  The error envelope becomes an `ApiError` (`code`, `details`, extras such as `attemptsLeft`). `getAll` follows pagination (API max 100).
- `src/lib/auth.tsx`: session restore on load (refresh → `/auth/me`), login, invite acceptance, logout; clears the query cache.
- `src/lib/i18n.tsx` + `src/lib/en.ts`: German is the source text, `t('Deutscher Text', {param})` returns the English entry in English.
  `tests/unit/i18n.test.ts` fails if a used text has no English entry (or an entry is unused, or placeholders differ).
- `src/lib/zone.ts`: `datetime-local` values are interpreted in the **hotel's** time zone (not the browser's), including the repeated hour at the
  autumn clock change (later occurrence, same as the server).
- The tablet never sends a time; the clock on screen is the server time plus the measured offset.
- Dates like `2026-10-05` are handled as plain strings (`src/lib/format.ts`), never through the browser time zone.

## Run it

```bash
# backend (from backend/): npm run migrate && npm run seed && npm run dev      (API on :3000)
cd frontend
npm ci
npm run dev            # http://localhost:5173, /api is proxied to http://localhost:3000 (API_URL overrides)
```

Demo logins after `npm run seed` (password `Demo-Password-2026`): `admin@tripinn.example`, `manager.frankfurt@tripinn.example`,
`regional@tripinn.example`, `maria@tripinn.example`. The backend's `CORS_ORIGINS` must contain the frontend origin (`http://localhost:5173` is the default).

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
npm run test:e2e       # real backend + real PostgreSQL + Chromium; creates, migrates and seeds its own database shiftsched_e2e
```

- Unit tests (vitest): date helpers, DST-safe local↔instant conversion, API client (refresh, single-flight, errors, pagination), i18n completeness.
- End-to-end (Playwright, 18 scenarios): sign-in/redirects/session restore/role access, language switch, roster planning → publish → employee sees it,
  rule refusal, vacation request → approval → balance, tablet pairing → wrong PIN → unplanned clock-in with reason → clock-out → supervisor approval,
  onboarding with vacation balances and automatic carry-over, shift design by admin and staffing, invite link → activation, audit log, questions and
  notifications, wishes, time correction, profile/PIN/password, period lock and payroll download.
  Locally set `PW_CHROMIUM=/path/to/chrome` to use an installed Chromium; set `E2E_DATABASE_URL` for another PostgreSQL.

## Deployment

`frontend/Dockerfile` builds the bundle and serves it with nginx (`frontend/nginx.conf`): SPA fallback, hashed assets cached for a year,
`index.html` never cached, a strict Content-Security-Policy, and `/api/` proxied to the backend (`http://backend:3000`). Serving the app and the API
from one origin keeps the refresh cookie (`SameSite=Strict`, `Path=/api/v1/auth`) first-party. Backend settings for that setup: `CORS_ORIGINS=https://<app host>`,
`APP_URL=https://<app host>`, `TRUST_PROXY=1` (nginx is one hop), `COOKIE_SECURE=true`, HTTPS in front of nginx. See `DEPLOYMENT.md` for the backend side.
The image build itself was not run in the authoring environment (no Docker daemon); the production bundle was built and smoke-tested with `vite preview`.

## Known limits

- No offline mode: the tablet needs the network (a punch without a server time would be invalid by design).
- Hotel settings (`PUT /hotels/:id/settings`) are not editable in the UI yet; use the API.
- Public holidays, anonymisation and the cross-hotel assignment history have no screen yet.
- Accessibility: semantic landmarks, labelled controls, focus rings, `role=alert/status` for messages; no full screen-reader audit has been done.
