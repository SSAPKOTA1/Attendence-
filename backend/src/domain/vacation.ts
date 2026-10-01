/** R9 remaining vacation for one year. */
export function remainingVacation(input: {
  vacationDaysPerYear: number;
  carriedOverDays: number;
  carryOverExpiresOn: string | null;
  usedDays: number;
  usedOnOrBeforeExpiry: number;
  today: string;
}): number {
  // usedDays / usedOnOrBeforeExpiry already include the days taken before onboarding (SPEC 1.14)
  const { vacationDaysPerYear, carriedOverDays, carryOverExpiresOn, usedDays, usedOnOrBeforeExpiry, today } = input;
  if (!carryOverExpiresOn || today <= carryOverExpiresOn) {
    return vacationDaysPerYear + carriedOverDays - usedDays;
  }
  return vacationDaysPerYear + Math.min(carriedOverDays, usedOnOrBeforeExpiry) - usedDays;
}

/**
 * JArbSchG §19 minimum for minors, converted from Werktage (6-day week) to the employee's work weekdays:
 * 30 / 27 / 25 Werktage if under 16 / 17 / 18 at the start of the year. Null for adults.
 */
export function statutoryMinimumForMinor(ageAtYearStart: number, workWeekdayCount: number): number | null {
  let werktage: number | null = null;
  if (ageAtYearStart < 16) werktage = 30;
  else if (ageAtYearStart < 17) werktage = 27;
  else if (ageAtYearStart < 18) werktage = 25;
  if (werktage === null) return null;
  return Math.ceil((werktage * workWeekdayCount) / 6);
}
