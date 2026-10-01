import { expect, test } from '@playwright/test';
import { login, MANAGER } from './helpers';

// The backend revokes the whole session family when a rotated refresh token is presented twice, so several open tabs must never
// refresh at the same moment. (The e2e backend issues 8 s access tokens.)
test('two tabs whose access tokens expire together both stay signed in', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const a = await ctx.newPage();
  await login(a, MANAGER);
  await expect(a.getByRole('table', { name: 'Dienstplan' })).toBeVisible();
  const b = await ctx.newPage();
  await b.goto('/manage/live');
  await expect(b.getByRole('heading', { name: 'Live-Übersicht' })).toBeVisible();

  await a.waitForTimeout(9_500); // both access tokens are expired now
  // both tabs hit the API in the same instant
  await Promise.all([a.goto('/manage/requests'), b.goto('/manage/staff')]);
  await Promise.all([
    expect(a.getByRole('heading', { name: 'Anträge' })).toBeVisible(),
    expect(b.getByRole('heading', { name: 'Mitarbeiter', exact: true })).toBeVisible(),
  ]);
  await a.waitForTimeout(9_500);
  await a.getByRole('link', { name: 'Zeiten' }).click();
  await expect(a.getByRole('heading', { name: 'Zeiten', exact: true })).toBeVisible();
  await expect(a).not.toHaveURL(/login/);
  await ctx.close();
});

test('an idle tab refreshes silently and keeps working', async ({ page }) => {
  await login(page, MANAGER);
  await expect(page.getByRole('table', { name: 'Dienstplan' })).toBeVisible();
  await page.waitForTimeout(9_500);
  await page.getByRole('link', { name: 'Live' }).click();
  await expect(page.getByRole('heading', { name: 'Live-Übersicht' })).toBeVisible();
  await expect(page).not.toHaveURL(/login/);
});

test('a payroll download after the access token expired still works', async ({ page }) => {
  await login(page, MANAGER);
  await page.getByRole('link', { name: 'Tablet & Export' }).click();
  await page.waitForTimeout(9_500);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Herunterladen' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^payroll-/);
});
