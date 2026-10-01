import { defineConfig, devices } from '@playwright/test';

// E2E runs the real backend (own PostgreSQL database, migrated and seeded by tests/e2e/global-setup.ts) and the Vite dev server.
const API_PORT = 3100;
const WEB_PORT = 5174;
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shiftsched_e2e';
export const backendEnv = {
  NODE_ENV: 'development', PORT: String(API_PORT), DATABASE_URL: DB, JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
  APP_URL: `http://localhost:${WEB_PORT}`, CORS_ORIGINS: `http://localhost:${WEB_PORT}`, MAIL_MODE: 'console', BCRYPT_COST: '4', LOG_LEVEL: 'warn',
  ACCESS_TOKEN_TTL_SECONDS: '8', JOBS_ENABLED: 'false', // short-lived access tokens: every longer test also exercises the silent refresh
   COOKIE_SECURE: 'false', RATE_LIMIT_USER_PER_MIN: '100000', LOGIN_RATE_LIMIT: '1000', KIOSK_RATE_LIMIT: '100000', TRUST_PROXY: 'loopback',
};

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'npx tsx src/server.ts', cwd: '../backend', url: `http://localhost:${API_PORT}/api/v1/health`, env: backendEnv, reuseExistingServer: false, timeout: 60_000 },
    { command: `npx vite --port ${WEB_PORT} --strictPort`, url: `http://localhost:${WEB_PORT}`, env: { API_URL: `http://localhost:${API_PORT}` }, reuseExistingServer: false, timeout: 60_000 },
  ],
});
