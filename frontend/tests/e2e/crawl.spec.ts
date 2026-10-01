import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { ADMIN, login, MANAGER, MARIA } from './helpers';

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const MANAGE = ['/manage/roster', '/manage/live', '/manage/requests', '/manage/staff', '/manage/staff/1', '/manage/inquiries', '/manage/attendance', '/manage/analytics', '/manage/devices', '/manage/setup'];
const PORTAL = ['/portal', '/portal/schedule', '/portal/time-off', '/portal/wishes', '/portal/attendance', '/portal/inquiries'];
const COMMON = ['/notifications', '/profile'];

// Every screen, every role: no script errors, no failed API calls, no "undefined/NaN" in the text, no WCAG A/AA violations,
// and no horizontal page scroll on a phone.
for (const [who, routes] of [[ADMIN, [...MANAGE, ...COMMON]], [MANAGER, [...MANAGE, ...COMMON]], [MARIA, [...PORTAL, ...COMMON]]] as const) {
  test(`crawl as ${who}: no errors, accessible, fits a phone`, async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin', viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const problems: string[] = [];
    let where = 'login';
    page.on('pageerror', (e) => problems.push(`${where}: script error ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/auth/refresh')) problems.push(`${where}: HTTP ${r.status()} ${r.url()}`); });
    await login(page, who);
    for (const route of routes) {
      where = route;
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(new RegExp(`${route}$`));
      await page.evaluate(axeSource);
      const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map((v: any) => `${v.id}: ${v.nodes[0].html.slice(0, 80)}`));
      for (const v of violations) problems.push(`${route}: a11y ${v}`);
      const text = await page.locator('body').innerText();
      if (/undefined|NaN|\[object|Invalid (date|time)/i.test(text)) problems.push(`${route}: bad text in page`);
    }
    await page.setViewportSize({ width: 390, height: 800 });
    for (const route of routes.filter((r) => r !== '/manage/roster')) {
      where = route;
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 2) problems.push(`${route}: scrolls horizontally by ${overflow}px on a phone`);
    }
    expect(problems).toEqual([]);
    await ctx.close();
  });
}
