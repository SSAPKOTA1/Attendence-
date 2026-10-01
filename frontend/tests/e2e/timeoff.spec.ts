import { expect, test } from '@playwright/test';
import { apiAs, login, MANAGER, MARIA, monday } from './helpers';

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

test('sick report: no reason field, no diagnosis, shows up in the list', async ({ page }) => {
  await login(page, MARIA);
  await page.goto('/portal/time-off?sick=1');
  await expect(page.getByLabel('Art')).toHaveValue('sick_leave');
  await expect(page.getByLabel('Grund (optional)')).toHaveCount(0);
  await page.getByLabel('Von').fill(monday(15));
  await page.getByLabel('Bis').fill(monday(15));
  await page.getByRole('button', { name: 'Krank melden' }).click();
  await expect(page.getByText('Antrag gesendet.')).toBeVisible();
  await expect(page.getByRole('row', { name: /Krank/ })).toBeVisible();
});

test('a request above the remaining vacation is refused with the reason shown', async ({ page }) => {
  await login(page, MARIA);
  await page.goto('/portal/time-off');
  await page.getByLabel('Von').fill(monday(2));
  const end = new Date(`${monday(2)}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 70); // ~50 working days in one year, more than the balance
  await page.getByLabel('Bis').fill(end.toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Beantragen' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Antrag gesendet.')).toHaveCount(0);
});

test('a blocking leave blackout refuses the request', async ({ page, request }) => {
  const mgr = await apiAs(request, MANAGER);
  const start = monday(12); const end = new Date(`${start}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
  expect((await mgr.post('/leave-blackouts', { hotelId: 1, startDate: start, endDate: end.toISOString().slice(0, 10), reason: 'Trade fair', mode: 'block' })).status).toBe(201);
  await login(page, MARIA);
  await page.goto('/portal/time-off');
  await page.getByLabel('Von').fill(start);
  await page.getByLabel('Bis').fill(start);
  await page.getByRole('button', { name: 'Prüfen' }).click();
  await expect(page.getByText(/Trade fair|leave_blackout/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Beantragen' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
});
