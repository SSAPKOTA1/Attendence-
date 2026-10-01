/**
 * Application clock. Every business timestamp (punches, token expiry, "today" in a hotel) comes from here,
 * never from the client. Tests pin it with setNow().
 */
let fixed: number | null = null;

export function now(): Date {
  return new Date(fixed ?? Date.now());
}

export function setNow(value: Date | string | null): void {
  fixed = value === null ? null : new Date(value).getTime();
}

export function advance(ms: number): void {
  fixed = (fixed ?? Date.now()) + ms;
}
