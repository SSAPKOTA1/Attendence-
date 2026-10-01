export type Role = 'staff' | 'manager' | 'admin';
export interface User {
  id: number; email: string | null; username: string | null; firstName: string; role: Role;
  hotelIds: number[]; employeeId: number | null; preferredLanguage: 'de' | 'en';
}
export interface Hotel { id: number; name: string; city?: string; timezone: string; attendanceLockedUntil?: string | null }
export interface Department { id: number; hotelId: number; name: string; color: string }
export interface Shift { id: number; hotelId: number; departmentId: number; name: string; startTime: string; endTime: string; durationHours: number; breakDurationMinutes: number; paidHours: number }
export interface Warning { type: string; severity?: string; message?: string; [k: string]: unknown }
export interface ScheduleEntry {
  id: number; status: 'draft' | 'published'; entryType: 'shift' | 'off'; date: string; offLabel?: string | null;
  employee: { id: number; firstName?: string; lastName?: string; displayName?: string };
  shift: { id: number; name: string; departmentId: number; startTime: string; endTime: string; paidHours?: number } | null;
  warnings?: Warning[]; hotelId?: number;
}
export interface Employee {
  id: number; firstName: string; lastName: string; email?: string | null; phone?: string | null; status: string; employeeNumber?: string | null;
  employmentType?: string; payType?: 'salary' | 'hourly'; publicHolidaysOff?: boolean; homeHotelId?: number; isHome?: boolean;
  hotels?: { id: number; name: string; isHome: boolean }[]; departments?: Department[]; workWeekdays?: number[]; hourlyRate?: number | null;
  birthDate?: string | null; hiredOn?: string | null; updatedAt?: string;
}
export interface Allowance {
  employeeId: number; year: number; vacationDaysPerYear: number; carriedOverDays: number; carryOverExpiresOn: string | null;
  carryOverAutomatic: boolean; alreadyTakenDays: number; usedDays: number; pendingDays: number; remainingDays: number;
}
export interface TimeEntry {
  id: number; employeeId: number; scheduleId: number | null; status: 'open' | 'closed' | 'needs_review'; clockInAt: string; clockOutAt: string | null;
  breakMinutes: number; workedMinutes: number | null; sourceIn: string; sourceOut: string | null; anomalies: { type: string; minutes?: number }[];
  note: string | null; unplannedReason?: string | null; approvalStatus?: 'not_required' | 'pending' | 'approved' | 'rejected';
  employee?: { id: number; displayName?: string }; corrections?: any[];
}
export interface Paged<T> { data: T[]; meta: { page: number; limit: number; total: number } }
