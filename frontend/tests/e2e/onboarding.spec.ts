import { expect, test } from '@playwright/test';
import { ADMIN, login, MANAGER } from './helpers';

test('admin onboards an employee with vacation balances; carry-over flows into next year', async ({ page }) => {
  await login(page, ADMIN);
  await page.getByRole('link', { name: 'Mitarbeiter' }).click();
  await page.getByRole('button', { name: 'Mitarbeiter anlegen' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Vorname').fill('Nina');
  await dlg.getByLabel('Nachname').fill('Onboard');
  await dlg.getByLabel('Front Desk').check();
  await dlg.getByRole('radio', { name: /Gehalt \(Arbeitszeitkonto\)/ }).click();
  await dlg.getByLabel('Urlaubstage pro Jahr').fill('30');
  await dlg.getByLabel('Rest aus dem Vorjahr').fill('5');
  await dlg.getByLabel('Davon dieses Jahr noch übrig').fill('12');
  await expect(dlg.getByText('Schon genommen: 18 Tage')).toBeVisible();
  await dlg.getByRole('button', { name: 'Anlegen' }).click();

  await expect(page).toHaveURL(/\/manage\/staff\/\d+/);
  await expect(page.getByRole('heading', { name: 'Nina Onboard' })).toBeVisible();
  const stats = page.locator('.stats').first();
  await expect(stats.locator('.stat', { hasText: 'Übrig' })).toContainText('17');
  await expect(stats.locator('.stat', { hasText: 'Übertrag' })).toContainText('5');
  await expect(stats.locator('.stat', { hasText: 'Genommen' })).toContainText('18');

  await page.getByRole('button', { name: 'Nächstes Jahr' }).click();
  await expect(stats.locator('.stat', { hasText: 'Übertrag' })).toContainText('17');
  await expect(stats.locator('.stat', { hasText: 'Übertrag' })).toContainText('automatisch');
  await expect(stats.locator('.stat', { hasText: 'Übrig' })).toContainText('47');
});

test('managers cannot add employees (admin only) but see the staff list', async ({ page }) => {
  await login(page, MANAGER);
  await page.getByRole('link', { name: 'Mitarbeiter' }).click();
  await expect(page.getByRole('link', { name: /Maria Garcia/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mitarbeiter anlegen' })).toHaveCount(0);
});

test('anonymisation: only for terminated staff; before the retention period a reason is required', async ({ page }) => {
  await login(page, ADMIN);
  await page.getByRole('link', { name: 'Mitarbeiter' }).click();
  await page.getByRole('button', { name: 'Mitarbeiter anlegen' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Vorname').fill('Karl');
  await dlg.getByLabel('Nachname').fill('Vergessen');
  await dlg.getByLabel('Front Desk').check();
  await dlg.getByRole('radio', { name: /Gehalt \(Arbeitszeitkonto\)/ }).click();
  await dlg.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.getByRole('heading', { name: 'Karl Vergessen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anonymisieren' })).toHaveCount(0); // still active

  await page.getByLabel('Status').selectOption('terminated');
  await page.getByRole('button', { name: 'Speichern' }).first().click();
  await expect(page.getByText('Gespeichert.')).toBeVisible();

  await page.getByRole('button', { name: 'Anonymisieren' }).click();
  const confirm = page.getByRole('dialog');
  await confirm.getByRole('button', { name: 'Endgültig anonymisieren' }).click();
  await expect(confirm.getByText(/Aufbewahrungsfrist endet am/)).toBeVisible(); // retention not over: ask for a reason
  const final = confirm.getByRole('button', { name: 'Endgültig anonymisieren' });
  await expect(final).toBeDisabled();
  await confirm.getByLabel('Begründung').fill('Löschverlangen nach Art. 17 DSGVO');
  await final.click();
  await expect(page.getByRole('heading', { name: /Former employee #\d+/ })).toBeVisible();
  await expect(page.getByText('Anonymisiert', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anonymisieren' })).toHaveCount(0);
});
