import { expect, test, type Page } from '@playwright/test';
import { apiAs, login, MANAGER, MARIA } from './helpers';

async function enterPin(page: Page, pin: string) {
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
}

test('tablet: pair, wrong PIN, unplanned clock-in with reason, clock-out, supervisor approves', async ({ page, request, browser }) => {
  const mgr = await apiAs(request, MANAGER);
  const code = (await mgr.post('/kiosk/pairing-codes', { hotelId: 1, deviceName: 'E2E tablet' })).body.pairingCode as string;
  const employees = (await mgr.get('/employees?hotelId=1&limit=100')).data as any[];
  const maria = employees.find((e) => e.firstName === 'Maria');
  const pin = (await mgr.post(`/employees/${maria.id}/pin/reset`)).body.pin as string;

  await page.goto('/kiosk');
  await page.getByLabel('Kopplungscode').fill(code);
  await page.getByRole('button', { name: 'Koppeln' }).click();
  await expect(page.getByLabel('Name suchen')).toBeVisible();

  await expect(page.getByText(/kein Dienst in Sicht/)).toBeVisible(); // nobody is due: the list is empty until a name is typed
  await page.getByLabel('Name suchen').fill('Mari');
  await page.getByRole('button', { name: /Maria G/ }).click();
  await enterPin(page, pin === '000000' ? '111111' : '000000');
  await expect(page.getByRole('alert')).toContainText(/PIN falsch/);
  await enterPin(page, pin);
  await expect(page.getByText('kein Dienst geplant').first()).toBeVisible();
  const clockIn = page.getByRole('button', { name: 'Einstempeln' });
  await expect(clockIn).toBeDisabled(); // unplanned: a reason is required first
  await page.getByLabel('Grund').fill('Covering a sick colleague');
  await clockIn.click();
  await expect(page.getByRole('status').getByText(/Eingestempelt \d\d:\d\d/)).toBeVisible();
  await page.getByRole('button', { name: /Fertig/ }).click();

  await page.getByRole('button', { name: /Maria G/ }).click(); // clocked in: she is listed without searching
  await enterPin(page, pin);
  await page.getByRole('button', { name: 'Ausstempeln' }).click();
  await expect(page.getByText(/Ausgestempelt \d\d:\d\d/)).toBeVisible();
  await expect(page.getByText(/Ungeplanter Dienst/)).toBeVisible();
  await page.getByRole('button', { name: /Fertig/ }).click();

  // supervisor sees the unplanned time and approves it
  const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const mp = await ctx.newPage();
  await login(mp, MANAGER);
  await mp.getByRole('link', { name: 'Anträge' }).click();
  const row = mp.getByRole('row', { name: /Maria Garcia.*Covering a sick colleague/ });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Freigeben' }).click();
  await mp.getByRole('dialog').getByRole('button', { name: 'Bestätigen' }).click();
  await expect(row).toHaveCount(0);
  await mp.getByRole('link', { name: 'Zeiten' }).click();
  await expect(mp.getByRole('row', { name: /Maria Garcia.*Freigegeben/ })).toBeVisible();
  await ctx.close();

  // the employee sees the entry and its approval in the portal
  await login(page, MARIA);
  await page.getByRole('link', { name: 'Meine Zeiten' }).click();
  await expect(page.getByRole('row', { name: /Freigegeben/ })).toBeVisible();
});

test('a tablet that was never paired asks for a code; the PIN pad enforces 6 digits', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByRole('heading', { name: 'Tablet einrichten' })).toBeVisible();
  await page.getByLabel('Kopplungscode').fill('NOPE-NOPE');
  await page.getByRole('button', { name: 'Koppeln' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('tablet shows the hotel name, locks the PIN after repeated failures and a manager unlocks it', async ({ page, request }) => {
  const mgr = await apiAs(request, MANAGER);
  const code = (await mgr.post('/kiosk/pairing-codes', { hotelId: 1, deviceName: 'Lock tablet' })).body.pairingCode as string;
  const emp = ((await mgr.get('/employees?hotelId=1&limit=100')).data as any[]).find((e) => e.firstName === 'Mia');
  const pin = (await mgr.post(`/employees/${emp.id}/pin/reset`)).body.pin as string;
  await page.goto('/kiosk');
  await page.getByLabel('Kopplungscode').fill(code);
  await page.getByRole('button', { name: 'Koppeln' }).click();
  await expect(page.getByText('Trip Inn Frankfurt')).toBeVisible();

  const wrong = pin === '999999' ? '888888' : '999999';
  await page.getByLabel('Name suchen').fill('Mia');
  for (let i = 0; i < 5; i++) {
    await page.getByRole('button', { name: /Mia K/ }).click().catch(() => {});
    await enterPin(page, wrong);
    await expect(page.getByRole('alert')).toBeVisible();
    if (i < 4) await page.getByRole('button', { name: 'Abbrechen' }).click();
    if (i < 4) await page.getByLabel('Name suchen').fill('Mia');
  }
  await expect(page.getByRole('alert')).toContainText(/PIN gesperrt/);
  await page.getByRole('button', { name: 'Abbrechen' }).click();
  await page.getByLabel('Name suchen').fill('Mia');
  await page.getByRole('button', { name: /Mia K/ }).click();
  await enterPin(page, pin); // the right PIN is refused while locked
  await expect(page.getByRole('alert')).toContainText(/PIN gesperrt/);

  expect((await mgr.post(`/employees/${emp.id}/pin/unlock`)).status).toBe(204);
  await page.getByRole('button', { name: 'Abbrechen' }).click();
  await page.getByLabel('Name suchen').fill('Mia');
  await page.getByRole('button', { name: /Mia K/ }).click();
  await enterPin(page, pin);
  await expect(page.getByRole('button', { name: 'Einstempeln' })).toBeVisible();
});

test('a revoked tablet falls back to the pairing screen', async ({ page, request }) => {
  const mgr = await apiAs(request, MANAGER);
  const code = (await mgr.post('/kiosk/pairing-codes', { hotelId: 1, deviceName: 'Revoke me' })).body.pairingCode as string;
  await page.goto('/kiosk');
  await page.getByLabel('Kopplungscode').fill(code);
  await page.getByRole('button', { name: 'Koppeln' }).click();
  await expect(page.getByLabel('Name suchen')).toBeVisible();
  const devices = (await mgr.get('/kiosk/devices')).data as any[];
  const mine = devices.find((d) => d.name === 'Revoke me');
  await request.delete(`http://localhost:3100/api/v1/kiosk/devices/${mine.id}`, { headers: { Authorization: `Bearer ${(await (await request.post('http://localhost:3100/api/v1/auth/login', { data: { login: MANAGER, password: 'Demo-Password-2026' }, headers: { 'X-Client': 'native' } })).json()).accessToken}` } });
  await page.getByLabel('Name suchen').fill('Ma'); // next roster request is refused
  await expect(page.getByRole('heading', { name: 'Tablet einrichten' })).toBeVisible();
});
