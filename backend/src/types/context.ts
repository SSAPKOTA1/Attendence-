import type { Lang } from '../errors/catalog';

export type Role = 'staff' | 'manager' | 'admin';

export interface AuthContext {
  userId: number;
  role: Role;
  companyId: number;
  /** manager: user_hotel_access; admin: every hotel of the company; staff: hotels the employee is assigned to */
  hotelIds: number[];
  employeeId: number | null;
  lang: Lang;
  /** refresh-token family of the current login (session id) */
  sessionId: string | null;
  requestId: string;
  ip?: string;
}

export interface DeviceContext {
  deviceId: number;
  hotelId: number;
  name: string;
}
