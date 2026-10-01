import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { setupWorld, World } from '../helpers/fixtures';
import { closePool } from '../../src/db/pool';
import { setNow } from '../../src/clock';

let w: World;
beforeAll(async () => {
  w = await setupWorld();
});
afterAll(() => closePool());

const ADMIN = () => as(w.tokens.admin);
const allowance = async (id: number, year: number) => (await ADMIN().get(`/employees/${id}/vacation-allowance?year=${year}`)).body;
async function onboard(vacation: object) {
  const r = await ADMIN().post('/employees', { payType: 'salary', firstName: 'New', lastName: 'Hire', homeHotelId: w.h1, departmentIds: [w.d1], vacation });
  expect(r.status).toBe(201);
  return r.body.id as number;
}

describe('SPEC 1.14: vacation at onboarding and automatic carry-over', () => {
  it('stores yearly days, days left from last year and days left this year', async () => {
    const id = await onboard({ vacationDaysPerYear: 30, carriedOverDays: 5, remainingThisYearDays: 12 });
    const a = await allowance(id, 2026);
    expect(a).toMatchObject({ vacationDaysPerYear: 30, carriedOverDays: 5, alreadyTakenDays: 18, usedDays: 18, remainingDays: 17, carryOverAutomatic: false });
  });

  it('rejects "left this year" above the yearly entitlement', async () => {
    const r = await ADMIN().post('/employees', { payType: 'salary', firstName: 'X', lastName: 'Y', homeHotelId: w.h1, vacation: { vacationDaysPerYear: 20, remainingThisYearDays: 25 } });
    expect(r.status).toBe(400);
  });

  it('carries what is left into next year automatically and follows later changes', async () => {
    const id = await onboard({ vacationDaysPerYear: 30, carriedOverDays: 5, remainingThisYearDays: 12 });
    let next = await allowance(id, 2027);
    expect(next).toMatchObject({ vacationDaysPerYear: 30, carriedOverDays: 17, carryOverAutomatic: true, carryOverExpiresOn: '2027-03-31', remainingDays: 47 });
    // two approved vacation days this year reduce the carry-over
    const t = await ADMIN().post(`/employees/${id}/time-offs`, { type: 'annual_leave', startDate: '2026-10-05', endDate: '2026-10-06', status: 'approved' });
    expect(t.status).toBe(201);
    next = await allowance(id, 2027);
    expect(next.carriedOverDays).toBe(15);
    expect(next.remainingDays).toBe(45);
  });

  it('chains over several years, lapses after the expiry date and honours the cap', async () => {
    const id = await onboard({ vacationDaysPerYear: 30, carriedOverDays: 0, remainingThisYearDays: 10 });
    expect((await allowance(id, 2027)).carriedOverDays).toBe(10);
    expect((await allowance(id, 2028)).carriedOverDays).toBe(40); // 10 + 30 unused in 2027
    // 2027 carry lapses when none of it was used before 31 March → the chain stops growing only if today is past expiry
    const cur = (await ADMIN().get(`/hotels/${w.h1}/settings`)).body;
    const put = await ADMIN().put(`/hotels/${w.h1}/settings`, { ...cur, absence: { ...cur.absence, maxCarryOverDays: 5 } });
    expect(put.status).toBe(200);
    expect((await allowance(id, 2028)).carriedOverDays).toBe(5);
    await ADMIN().put(`/hotels/${w.h1}/settings`, cur);
    // once the 2027 expiry date has passed, unused 2027 carry-over lapses: only the 30 own days are left to carry
    setNow('2028-01-10T10:00:00Z');
    expect((await allowance(id, 2028)).carriedOverDays).toBe(30);
    setNow('2026-10-01T06:00:00Z');
  });

  it('a manual value can be set and switched back to automatic', async () => {
    const id = await onboard({ vacationDaysPerYear: 30, carriedOverDays: 0, remainingThisYearDays: 20 });
    const set = await as(w.tokens.manager1).put(`/employees/${id}/vacation-allowance`, { year: 2027, vacationDaysPerYear: 28, carriedOverDays: 3 });
    expect(set.body).toMatchObject({ carriedOverDays: 3, carryOverAutomatic: false, vacationDaysPerYear: 28 });
    const auto = await as(w.tokens.manager1).put(`/employees/${id}/vacation-allowance`, { year: 2027, vacationDaysPerYear: 28, carriedOverDays: null });
    expect(auto.body).toMatchObject({ carriedOverDays: 20, carryOverAutomatic: true });
  });
});
