import { expect, test } from '@playwright/test';
import { ADMIN, apiAs, login, MANAGER } from './helpers';

test('admin designs a shift in the app; the manager can use it in the roster', async ({ page, browser }) => {
  await login(page, ADMIN);
  await page.getByRole('link', { name: 'Einrichtung' }).click();
  await page.getByRole('button', { name: 'Neuer Dienst' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Spätdienst E2E');
  await dlg.getByLabel('Beginn').fill('15:00');
  await dlg.getByLabel('Ende').fill('23:00');
  await dlg.getByLabel('Pause (Minuten)').fill('30');
  await dlg.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('row', { name: /Spätdienst E2E/ })).toContainText('15:00–23:00');

  const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const mp = await ctx.newPage();
  await login(mp, MANAGER);
  await mp.getByRole('link', { name: 'Einrichtung' }).click();
  await expect(mp.getByRole('button', { name: 'Neuer Dienst' })).toHaveCount(0); // managers cannot design shifts
  await expect(mp.getByRole('row', { name: /Spätdienst E2E/ })).toBeVisible();
  await mp.getByRole('row', { name: /Spätdienst E2E/ }).getByRole('button', { name: 'Mindestbesetzung' }).click();
  await mp.getByRole('dialog').getByLabel('Mo').fill('2');
  await mp.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
  await mp.goto('/manage/roster');
  await mp.getByRole('row', { name: /Lena Brandt/ }).getByRole('cell').nth(0).click();
  await expect(mp.getByRole('dialog').getByLabel('Dienst')).toContainText('Spätdienst E2E 15:00–23:00');
  await ctx.close();
});

test('user management: invite link for an employee without e-mail, then the employee sets a password and signs in', async ({ page, browser, request }) => {
  await login(page, ADMIN);
  const admin = await apiAs(request, ADMIN);
  const created = await admin.post('/employees', { firstName: 'Ina', lastName: 'Invitee', payType: 'hourly', homeHotelId: 1 });
  expect(created.status).toBe(201);
  await page.getByRole('link', { name: 'Einrichtung' }).click();
  await page.getByRole('tab', { name: 'Benutzer' }).click();
  await page.getByRole('button', { name: 'Benutzer anlegen' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('E-Mail oder Benutzername').fill('kai.e2e');
  await dlg.getByLabel('Gehört zu Mitarbeiter').selectOption({ label: 'Ina Invitee' });
  await dlg.getByRole('button', { name: 'Anlegen & Link erzeugen' }).click();
  const link = await page.getByRole('dialog').getByLabel('Link').inputValue();
  expect(link).toContain('accept-invite?token=');

  const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const ep = await ctx.newPage();
  await ep.goto(new URL(link).pathname + new URL(link).search);
  await ep.getByLabel('Neues Passwort').fill('A-very-long-secret-2026');
  await ep.getByLabel('Passwort wiederholen').fill('A-very-long-secret-2026');
  await ep.getByRole('button', { name: 'Speichern' }).click();
  await expect(ep).toHaveURL(/\/portal$/);
  await expect(ep.getByRole('heading', { name: /Hallo/ })).toBeVisible();
  await ctx.close();
});

test('audit log lists what happened', async ({ page }) => {
  await login(page, ADMIN);
  await page.getByRole('link', { name: 'Einrichtung' }).click();
  await page.getByRole('tab', { name: 'Protokoll' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByLabel('Aktion (genau, z. B. shift.create)').fill('shift.create');
  await expect(page.getByRole('cell', { name: /shift\.create/ }).first()).toBeVisible();
});
