export type NameFormat = 'first_last_initial' | 'full';

/** "Maria G." (default) or "Maria Garcia" */
export function displayName(firstName: string, lastName: string, format: NameFormat = 'first_last_initial'): string {
  if (format === 'full') return `${firstName} ${lastName}`.trim();
  const initial = lastName ? `${lastName.trim().charAt(0).toUpperCase()}.` : '';
  return `${firstName} ${initial}`.trim();
}
