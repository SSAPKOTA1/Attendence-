/** R13.10: monthly delta = worked + credited − target; balance = opening + Σ deltas. */
export function monthDelta(workedMinutes: number, creditedMinutes: number, targetMinutes: number): number {
  return workedMinutes + creditedMinutes - targetMinutes;
}

export function balanceHours(openingBalanceHours: number, deltasMinutes: number[]): number {
  const total = openingBalanceHours * 60 + deltasMinutes.reduce((a, b) => a + b, 0);
  return Math.round((total / 60) * 100) / 100;
}

/** R8: unpaid/other days reduce the monthly target proportionally. */
export function adjustedMonthlyTarget(targetHoursPerMonth: number, workDaysInMonth: number, reducedDays: number): number {
  if (workDaysInMonth <= 0) return targetHoursPerMonth * 60;
  return Math.max(0, targetHoursPerMonth * 60 * (1 - reducedDays / workDaysInMonth));
}
