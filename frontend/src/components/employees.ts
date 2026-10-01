import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAll } from '../lib/api';
import type { Employee } from '../lib/types';

/** All employees assigned to the hotel (shared cache with the roster) plus an id -> name lookup. */
export function useHotelEmployees(hotelId?: number, status?: string) {
  const q = useQuery({ queryKey: ['roster', 'employees', hotelId, status ?? 'active'], enabled: !!hotelId, queryFn: () => getAll<Employee>('/employees', { hotelId, ...(status ? { status } : {}) }) });
  const names = useMemo(() => new Map((q.data ?? []).map((e) => [e.id, `${e.firstName} ${e.lastName}`])), [q.data]);
  return { ...q, names, nameOf: (id: number) => names.get(id) ?? `#${id}` };
}
