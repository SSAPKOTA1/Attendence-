import { expect, test } from '@playwright/test';
import { apiAs, login, MANAGER, MARIA, PASSWORD, monday } from './helpers';

test('questions: employee asks, manager answers, employee sees the answer', async ({ page, browser }) => {
  await login(page, MARIA);
  await page.getByRole('link', { name: 'Fragen' }).click();
  await page.getByRole('button', { name: 'Neue Frage' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Betreff').fill('Why was my break deducted?');
  await dlg.getByLabel('Nachricht').fill('On Tuesday I worked through.');
  await dlg.getByRole('button', { name: 'Frage senden' }).click();
  await expect(page.getByRole('dialog').getByText('On Tuesday I worked through.')).toBeVisible();
  await page.keyboard.press('Escape');

  const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const mp = await ctx.newPage();
  await login(mp, MANAGER);
  await mp.getByRole('link', { name: 'Fragen' }).click();
  await mp.getByRole('button', { name: 'Why was my break deducted?' }).click();
  await mp.getByLabel('Antwort', { exact: true }).fill('The scheduled break is deducted automatically.');
  await mp.getByRole('button', { name: 'Senden' }).click();
  await expect(mp.getByRole('dialog').getByText('The scheduled break is deducted automatically.')).toBeVisible();
  await ctx.close();

  await page.reload();
  await expect(page.getByRole('row', { name: /Why was my break deducted\?.*Beantwortet/ })).toBeVisible();
  await page.getByRole('link', { name: /Mitteilungen/ }).click();
  await expect(page.getByText('Antwort auf deine Frage')).toBeVisible();
  await page.getByRole('button', { name: 'Alle als gelesen markieren' }).click();
  await expect(page.getByText('0 ungelesen')).toBeVisible();
});

test('wishes: send a day-off wish and a leave wish, manager approves one', async ({ page, browser }) => {
  await login(page, MARIA);
  await page.getByRole('link', { name: 'Wünsche', exact: true }).click();
  await page.getByLabel('Datum').fill(monday(3));
  await page.getByLabel('Grund (optional)').first().fill('Dentist');
  await page.getByRole('button', { name: 'Wunsch senden' }).first().click();
  await expect(page.getByText('Wunsch gesendet.').first()).toBeVisible();
  await expect(page.getByRole('row', { name: /Dentist/ })).toBeVisible();

  const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const mp = await ctx.newPage();
  await login(mp, MANAGER);
  await mp.getByRole('link', { name: 'Anträge' }).click();
  const row = mp.getByRole('row', { name: /Maria G\..*Freiwunsch/ });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Genehmigen' }).click();
  await mp.getByRole('dialog').getByRole('button', { name: 'Bestätigen' }).click();
  await expect(row).toHaveCount(0);
  await ctx.close();
  await page.reload();
  await expect(page.getByRole('row', { name: /Dentist.*Genehmigt/ })).toBeVisible();
});

test('profile: language is saved, password and PIN can be changed', async ({ page, request }) => {
  await login(page, MARIA);
  await page.getByRole('link', { name: 'Profil' }).click();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await page.getByRole('button', { name: 'Deutsch' }).click();
  await expect(page.getByRole('heading', { name: 'Profil' })).toBeVisible();

  await page.getByLabel('Aktuelles Passwort').fill(PASSWORD);
  await page.getByLabel('Neues Passwort').fill('Another-long-secret-2026');
  await page.getByRole('button', { name: 'Passwort ändern' }).click();
  await expect(page.getByText('Passwort geändert.')).toBeVisible();

  await page.getByLabel('Passwort', { exact: true }).fill('Another-long-secret-2026');
  await page.getByLabel('Neue PIN (6 Ziffern)').fill('246802');
  await page.getByRole('button', { name: 'PIN ändern' }).click();
  await expect(page.getByText('PIN geändert.')).toBeVisible();
  // restore the shared demo password so later specs are independent of this one
  await page.getByLabel('Aktuelles Passwort').fill('Another-long-secret-2026');
  await page.getByLabel('Neues Passwort').fill(PASSWORD);
  await page.getByRole('button', { name: 'Passwort ändern' }).click();
  await expect(page.getByText('Passwort geändert.')).toBeVisible();
  void request; void apiAs;
});

test('manager: lock a period and download the payroll export', async ({ page }) => {
  await login(page, MANAGER);
  await page.getByRole('link', { name: 'Tablet & Export' }).click();
  await page.getByLabel('Format').selectOption('csv');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Herunterladen' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^payroll-\d{4}-\d{2}\.csv$/);
  await page.getByLabel('Gesperrt bis einschließlich').fill(new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Sperren', exact: true }).click();
  await expect(page.getByText('Gespeichert.')).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Gesperrt bis \d{4}-\d{2}-\d{2}\./)).toBeVisible();
});

test('time correction: employee requests it, manager approves, the entry changes', async ({ page, request, browser }) => {
  const mgr = await apiAs(request, MANAGER);
  const maria = ((await mgr.get('/employees?hotelId=1&limit=100')).data as any[]).find((e) => e.firstName === 'Maria');
  const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const made = await mgr.post('/attendance', { hotelId: 1, employeeId: maria.id, clockInAt: `${day}T06:00:00Z`, clockOutAt: `${day}T12:00:00Z`, breakMinutes: 0, reason: 'seed for e2e' });
  expect(made.status).toBe(201);

  await login(page, MARIA);
  await page.getByRole('link', { name: 'Meine Zeiten' }).click();
  await page.getByRole('row', { name: /6:00 h/ }).getByRole('button', { name: 'Korrigieren' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Richtige Ausstempelzeit').fill(`${day}T15:00`);
  await dlg.getByLabel('Pause (Minuten)').fill('30');
  await dlg.getByLabel('Begründung').fill('Forgot to clock out at noon');
  await dlg.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByRole('heading', { name: 'Meine Korrekturen' })).toBeVisible();

  const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const mp = await ctx.newPage();
  await login(mp, MANAGER);
  await mp.getByRole('link', { name: 'Anträge' }).click();
  const row = mp.getByRole('row', { name: /Maria Garcia.*Forgot to clock out at noon/ });
  await row.getByRole('button', { name: 'Genehmigen' }).click();
  await mp.getByRole('dialog').getByRole('button', { name: 'Bestätigen' }).click();
  await expect(row).toHaveCount(0);
  await ctx.close();

  await page.reload();
  await expect(page.getByRole('row', { name: /15:00/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /30 min/ })).toBeVisible();
});

test('manager: the payroll export is an Excel table by default', async ({ page }) => {
  await login(page, MANAGER);
  await page.getByRole('link', { name: 'Tablet & Export' }).click();
  await expect(page.getByLabel('Format')).toHaveValue('xlsx');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Herunterladen' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^lohn-\d{4}-\d{2}\.xlsx$/);
  const path = await download.path();
  const { readFileSync } = await import('node:fs');
  expect(readFileSync(path).subarray(0, 2).toString()).toBe('PK'); // a real .xlsx (zip) file
});
