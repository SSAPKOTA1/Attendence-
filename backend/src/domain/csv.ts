function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], data: Record<string, unknown>[]): string {
  const lines = [headers.join(',')];
  for (const r of data) lines.push(headers.map((h) => cell(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}
