# CLAUDE.md

`docs/SPEC.md` is the single source of truth for names, endpoints, rules and error codes. Read the relevant sections before writing code. Never rename fields. Write the phase's tests first, then the code. Run `npm test` after every phase.

- Backend lives in `backend/` (TypeScript, Express, raw SQL via `pg`, zod, vitest + supertest against a real PostgreSQL 16).
- `backend/migrations/0001_init.sql` is spec Appendix A: never edit an applied migration, add a new one.
- Business rules live in `src/services` and `src/domain`; routes are thin; SQL lives in `src/repositories` (and services' small queries via the `Db` handle).
- Every timestamp comes from `src/clock.ts` (`now()`), never from the client and never from `Date.now()` directly in business logic.
- Commands (from `backend/`): `npm run typecheck`, `npm run lint`, `npm test`, `npm run migrate`, `npm run seed`, `npm run dev`.
- Tests need `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/shiftsched_test`).
- Implementation notes and interpretations of ambiguous spec points: `docs/IMPLEMENTATION_PLAN.md`.
- Frontend lives in `frontend/` (React 18, TypeScript, Vite; see `docs/FRONTEND.md`). Commands from `frontend/`: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` (starts the real backend + PostgreSQL, needs Chromium: `PW_CHROMIUM`). German is the source text for UI strings: every `t('…')` needs an English entry in `src/lib/en.ts`. The frontend never changes the backend's API; if the UI needs something new, extend the spec first.
