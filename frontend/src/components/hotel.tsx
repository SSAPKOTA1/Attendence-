import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Hotel } from '../lib/types';

interface Ctx { hotels: Hotel[]; hotel: Hotel | null; setHotelId: (id: number) => void; loading: boolean }
const HotelCtx = createContext<Ctx>({ hotels: [], hotel: null, setHotelId: () => {}, loading: true });
const KEY = 'manage.hotelId';

export function HotelProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['hotels'], queryFn: () => get<{ data: Hotel[] }>('/hotels').then((r) => r.data), enabled: !!user && user.role !== 'staff' });
  const [id, setId] = useState<number | null>(() => { try { return Number(localStorage.getItem(KEY)) || null; } catch { return null; } });
  const hotels = useMemo(() => q.data ?? [], [q.data]);
  const hotel = hotels.find((h) => h.id === id) ?? hotels[0] ?? null;
  useEffect(() => { try { if (hotel) localStorage.setItem(KEY, String(hotel.id)); } catch { /* ignore */ } }, [hotel]);
  return <HotelCtx.Provider value={{ hotels, hotel, setHotelId: setId, loading: q.isLoading }}>{children}</HotelCtx.Provider>;
}
export const useHotel = () => useContext(HotelCtx);
