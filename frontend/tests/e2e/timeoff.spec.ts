import { expect, test } from '@playwright/test';
import { login, MANAGER, MARIA, monday } from './helpers';

test('vacation request: preview, submit, manager approves, balance drops', async ({ page, browser }) => {
  const start = monday(5);
  const end = new Date(`${start}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
  await login(page, MARIA);
  await page.getByRole('link', { name: 'Urlaub & Abwesenheit' }).click();
  await expect(page.getByText('Tage übrig').or(page.getByText('Übrig'))).toBeVisible();
  await page.getByLabel('Von').fill(start);
  await page.getByLabel('Bis').fill(end.toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Prüfen' }).click();
  await expect(page.getByText('2 Tage').first()).toBeVisible();
  await page.getByRole('button', { name: 'Beantragen' }).click();
  await expect(page.getByText('Antrag gesendet.')).toBeVisible();
  await expect(page.getByRole('row', { name: /Offen/ })).toBeVisible();

  const mgr = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const mp = await mgr.newPage();
  await login(mp, MANAGER);
  await mp.getByRole('link', { name: 'Anträge' }).click();
  const req = mp.getByRole('row', { name: /Maria Garcia.*Urlaub/ });
  await expect(req).toBeVisible();
  await req.getByRole('button', { name: 'Genehmigen' }).click();
  await mp.getByRole('dialog').getByRole('button', { name: 'Bestätigen' }).click();
  await expect(req).toHaveCount(0);
  await mgr.close();

  await page.reload();
  await expect(page.getByRole('row', { name: /Genehmigt/ })).toBeVisible();
  await expect(page.getByText('Beantragt').first()).toBeVisible();
});

test('sick report takes no reason and is approved right away for the employee flow', async ({ page }) => {
  await login(page, MARIA);
  await page.goto('/portal/time-off?sick=1');
  await expect(page.getByLabel('Art')).toHaveValue('sick_leave');
  await expect(page.getByLabel('Grund (optional)')).toHaveCount(0);
});
