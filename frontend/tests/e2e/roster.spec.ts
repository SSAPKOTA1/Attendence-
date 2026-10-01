import { expect, test } from '@playwright/test';
import { ADMIN, apiAs, login, MANAGER, MARIA } from './helpers';

test('manager plans a shift, publishes it, and the employee sees it', async ({ page, browser }) => {
  await login(page, MANAGER);
  await page.getByRole('button', { name: 'Nächste Woche' }).click();
  const row = page.getByRole('row', { name: /Maria Garcia/ });
  await row.getByRole('cell').nth(0).click(); // Monday of next week
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Dienst').selectOption({ label: 'Early 06:00–14:00' });
  await dlg.getByRole('button', { name: 'Eintragen' }).click();
  await expect(dlg).toBeHidden();
  const chip = row.getByRole('button', { name: /Early 06:00–14:00/ });
  await expect(chip).toBeVisible();
  await expect(page.getByText('1 Entwürfe')).toBeVisible();

  // the employee does not see drafts
  const emp = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const ep = await emp.newPage();
  await login(ep, MARIA);
  await ep.getByRole('link', { name: 'Mein Dienstplan' }).click();
  await ep.getByRole('button', { name: 'Nächste Woche' }).click();
  await expect(ep.getByText('Early')).toHaveCount(0);

  await page.getByRole('button', { name: 'Veröffentlichen' }).click();
  await expect(page.getByText('veröffentlicht', { exact: true })).toBeVisible();

  await ep.reload();
  await ep.getByRole('button', { name: 'Nächste Woche' }).click();
  await expect(ep.getByText('Early').first()).toBeVisible();
  await expect(ep.getByText('06:00–14:00').first()).toBeVisible();
  await emp.close();
});

test('rule violations are shown instead of saved: a second overlapping shift is refused', async ({ page }) => {
  await login(page, MANAGER);
  await page.getByRole('button', { name: 'Nächste Woche' }).click();
  const row = page.getByRole('row', { name: /Jonas Schmidt/ });
  await row.getByRole('cell').nth(1).click();
  let dlg = page.getByRole('dialog');
  await dlg.getByLabel('Dienst').selectOption({ label: 'Early 06:00–14:00' });
  await dlg.getByRole('button', { name: 'Eintragen' }).click();
  await expect(dlg).toBeHidden();
  await row.getByRole('cell').nth(1).getByRole('button', { name: 'Dienst hinzufügen' }).click();
  dlg = page.getByRole('dialog');
  await dlg.getByLabel('Dienst').selectOption({ label: 'Breakfast 06:00–10:30' });
  await expect(dlg.getByRole('alert')).toBeVisible(); // SHIFT_OVERLAPS_EXISTING from the dry run
  await expect(dlg.getByRole('button', { name: 'Eintragen' })).toBeEnabled();
  await dlg.getByRole('button', { name: 'Eintragen' }).click();
  await expect(dlg.getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row.getByRole('button', { name: /Early/ })).toHaveCount(1);
  await expect(row.getByRole('button', { name: /Breakfast/ })).toHaveCount(0);
});

test('youth protection: a night shift for a minor needs a written reason before it can be saved', async ({ page, request }) => {
  const admin = await apiAs(request, ADMIN);
  expect((await admin.post('/employees', { firstName: 'Tim', lastName: 'Teen', payType: 'hourly', homeHotelId: 1, birthDate: '2010-05-05', employmentType: 'apprentice', departmentIds: [1] })).status).toBe(201);
  await login(page, MANAGER);
  await page.getByRole('button', { name: 'Nächste Woche' }).click();
  const row = page.getByRole('row', { name: /Tim Teen/ });
  await row.getByRole('cell').nth(2).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Dienst').selectOption({ label: 'Night 22:00–06:00' });
  await expect(dlg.getByText(/Jugendarbeitsschutz/)).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Eintragen' })).toBeDisabled();
  await dlg.getByLabel('Begründung (nötig)').fill('Agreed with the apprentice and the guardian');
  await dlg.getByRole('button', { name: 'Eintragen' }).click();
  await expect(row.getByRole('button', { name: /Night 22:00–06:00/ })).toBeVisible();
});
