export interface Anomaly {
  type: string;
  minutes?: number;
  [k: string]: unknown;
}

const mins = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;

/** R13.5 clock-in anomalies relative to the linked shift. Timestamps are never changed. */
export function clockInAnomalies(at: Date, shift: { start: Date } | null, s: { earlyClockInMinutes: number; lateToleranceMinutes: number }): Anomaly[] {
  if (!shift) return [{ type: 'unscheduled_work' }];
  const diff = mins(shift.start, at);
  if (diff < -s.earlyClockInMinutes) return [{ type: 'early_clock_in', minutes: Math.round(-diff) }];
  if (diff > s.lateToleranceMinutes) return [{ type: 'late_clock_in', minutes: Math.round(diff) }];
  return [];
}

/** R13.5 clock-out anomalies relative to the linked shift's end. */
export function clockOutAnomalies(at: Date, shift: { end: Date } | null, s: { lateToleranceMinutes: number; overtimeToleranceMinutes: number }): Anomaly[] {
  if (!shift) return [];
  const diff = mins(shift.end, at);
  if (diff < -s.lateToleranceMinutes) return [{ type: 'early_clock_out', minutes: Math.round(-diff) }];
  if (diff > s.overtimeToleranceMinutes) return [{ type: 'overtime', minutes: Math.round(diff) }];
  return [];
}

/** R13.6 auto break: scheduled break if gross >= 6 h; unscheduled work uses the legal break rules by gross time. */
export function autoBreakMinutes(grossMinutes: number, scheduledBreak: number | null, rules: { grossOverHours: number; minMinutes: number }[]): number {
  let brk = 0;
  if (scheduledBreak !== null) brk = grossMinutes >= 360 ? scheduledBreak : 0;
  else for (const r of rules) if (grossMinutes > r.grossOverHours * 60) brk = Math.max(brk, r.minMinutes);
  // a break must stay shorter than the worked time (DB check)
  return Math.max(0, Math.min(brk, Math.floor(grossMinutes) - 1));
}

export function workedMinutes(clockIn: Date, clockOut: Date | null, breakMinutes: number): number | null {
  if (!clockOut) return null;
  return Math.max(0, Math.floor(mins(clockIn, clockOut)) - breakMinutes);
}
