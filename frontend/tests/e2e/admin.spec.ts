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

test('hotel settings: admin changes them and they persist; invalid values are refused; managers can only read', async ({ page, browser }) => {
  await login(page, ADMIN);
  await page.getByRole('link', { name: 'Einrichtung' }).click();
  await page.getByRole('tab', { name: 'Hoteleinstellungen' }).click();
  const autoClose = page.getByLabel('Vergessenes Ausstempeln: Plan-Zeit nach … Std. gutschreiben (leer = aus)');
  await expect(autoClose).toHaveValue('5');
  await autoClose.fill('3');
  await page.getByLabel('Lohnart: Arbeitszeit').fill('2000');
  await page.getByRole('group', { name: 'Pausenregeln (Bruttozeit)' }).getByRole('button', { name: 'Regel hinzufügen' }).click();
  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  await expect(page.getByText('Gespeichert.')).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Hoteleinstellungen' }).click();
  await expect(page.getByLabel('Vergessenes Ausstempeln: Plan-Zeit nach … Std. gutschreiben (leer = aus)')).toHaveValue('3');
  await expect(page.getByLabel('Lohnart: Arbeitszeit')).toHaveValue('2000');
  await expect(page.getByRole('group', { name: 'Pausenregeln (Bruttozeit)' }).getByLabel('Minuten Pause')).toHaveCount(3);

  await page.getByLabel('Höchstzeit pro Tag (Std.)').first().fill('99'); // above the allowed 24 h
  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const mp = await ctx.newPage();
  await login(mp, MANAGER);
  await mp.getByRole('link', { name: 'Einrichtung' }).click();
  await mp.getByRole('tab', { name: 'Hoteleinstellungen' }).click();
  await expect(mp.getByLabel('Lohnart: Arbeitszeit')).toBeDisabled();
  await expect(mp.getByRole('button', { name: 'Einstellungen speichern' })).toHaveCount(0);
  await ctx.close();
});

test('LODAS export: asks for consultant/client number once, then downloads with the suggested wage types', async ({ page, browser }) => {
  const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const mp = await ctx.newPage();
  await login(mp, MANAGER);
  await mp.getByRole('link', { name: 'Tablet & Export' }).click();
  await mp.getByLabel('Format').selectOption('datev');
  await expect(mp.getByText(/Lohnarten sind Vorschläge/)).toBeVisible();
  await mp.getByRole('button', { name: 'Herunterladen' }).click();
  await expect(mp.getByRole('alert')).toContainText('Berater- und Mandantennummer');

  await login(page, ADMIN);
  await page.getByRole('link', { name: 'Einrichtung' }).click();
  await page.getByRole('tab', { name: 'Hoteleinstellungen' }).click();
  await expect(page.getByLabel('Lohnart: Arbeitszeit')).toHaveValue('2000');
  await page.getByLabel('Beraternummer').fill('1234567');
  await page.getByLabel('Mandantennummer').fill('12345');
  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  await expect(page.getByText('Gespeichert.')).toBeVisible();

  const [download] = await Promise.all([mp.waitForEvent('download'), mp.getByRole('button', { name: 'Herunterladen' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^payroll-\d{4}-\d{2}\.txt$/);
  await ctx.close();
});

test('public holidays: the setup tab lists the hotel region\'s holidays per year', async ({ page }) => {
  await login(page, ADMIN);
  await page.getByRole('link', { name: 'Einrichtung' }).click();
  await page.getByRole('tab', { name: 'Feiertage' }).click();
  const year = page.getByLabel('Jahr');
  await year.fill('2026');
  await expect(page.getByRole('row', { name: /Neujahr/ })).toContainText('01.01.2026');
  await expect(page.getByRole('row', { name: /Tag der Deutschen Einheit/ })).toBeVisible();
  await year.fill('2027');
  await expect(page.getByRole('row', { name: /Neujahr/ })).toContainText('01.01.2027');
});
