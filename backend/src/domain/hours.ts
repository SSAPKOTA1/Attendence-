/** R1: nominal duration (wraps midnight) and paid minutes of a shift definition. */
export function durationMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return e > s ? e - s : e - s + 1440;
}

export function paidMinutes(duration: number, breakMinutes: number): number {
  return Math.max(0, duration - breakMinutes);
}

export function toHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

/** Minimum break required by a list of rules for a given time (largest applicable rule wins). */
export function requiredBreak(
  minutes: number,
  rules: { overHours: number; minMinutes: number }[],
): number {
  let req = 0;
  for (const r of rules) if (minutes > r.overHours * 60) req = Math.max(req, r.minMinutes);
  return req;
}
