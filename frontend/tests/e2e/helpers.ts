import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'Demo-Password-2026';
export const MANAGER = 'manager.frankfurt@tripinn.example';
export const ADMIN = 'admin@tripinn.example';
export const MARIA = 'maria@tripinn.example';
const API = 'http://localhost:3100/api/v1';

export async function login(page: Page, who: string) {
  await page.goto('/login');
  await page.getByLabel(/E-Mail oder Benutzername|E-mail or username/).fill(who);
  await page.getByLabel(/Passwort|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /^(Anmelden|Sign in)$/ }).click();
}

/** Direct API session for set-up steps that are not what the test is about. */
export async function apiAs(request: APIRequestContext, who: string) {
  const r = await request.post(`${API}/auth/login`, { data: { login: who, password: PASSWORD }, headers: { 'X-Client': 'native' } });
  expect(r.ok()).toBeTruthy();
  const { accessToken } = await r.json();
  const headers = { Authorization: `Bearer ${accessToken}` };
  return {
    get: async (p: string) => (await request.get(`${API}${p}`, { headers })).json(),
    post: async (p: string, data: unknown = {}) => { const res = await request.post(`${API}${p}`, { headers, data }); return { status: res.status(), body: await res.json().catch(() => null) }; },
  };
}

export const monday = (weeksAhead: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + weeksAhead * 7 - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
