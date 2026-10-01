import { expect, test } from '@playwright/test';
import { ADMIN, login, MANAGER, MARIA } from './helpers';

test.describe('sign-in and access', () => {
  test('wrong password shows an error and stays on the login page', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-Mail oder Benutzername').fill(MANAGER);
    await page.getByLabel('Passwort').fill('definitely-wrong-password');
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('a protected page redirects to login and returns afterwards', async ({ page }) => {
    await page.goto('/manage/live');
    await expect(page).toHaveURL(/\/login/);
    await login(page, MANAGER);
    await expect(page).toHaveURL(/\/manage\/live/);
    await expect(page.getByRole('heading', { name: 'Live-Übersicht' })).toBeVisible();
  });

  test('the session survives a reload (refresh cookie) and ends on sign-out', async ({ page }) => {
    await login(page, MANAGER);
    await expect(page).toHaveURL(/\/manage\/roster/);
    await page.reload();
    await expect(page.getByRole('table', { name: 'Dienstplan' })).toBeVisible();
    await page.getByRole('button', { name: 'Abmelden' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
  });

  test('employees get the portal and cannot open manager pages', async ({ page }) => {
    await login(page, MARIA);
    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByRole('heading', { name: 'Hallo Maria' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Dienstplan', exact: true })).toHaveCount(0);
    await page.goto('/manage/staff');
    await expect(page).toHaveURL(/\/portal$/);
  });

  test('language switch translates the UI', async ({ page }) => {
    await login(page, ADMIN);
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Roster' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Requests' })).toBeVisible();
    await page.getByRole('button', { name: 'DE', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Anträge' })).toBeVisible();
  });
});
