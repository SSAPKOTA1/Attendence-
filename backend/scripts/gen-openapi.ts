/* Generates openapi.yaml from the endpoint catalog (spec section 8). Run: npx tsx scripts/gen-openapi.ts */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

type Role = 'P' | 'S' | 'M' | 'A' | 'D';
interface Ep {
  id: string;
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  role: Role;
  tag: string;
  summary: string;
  query?: string[];
  body?: string; // schema name
  ok?: number;
  response?: string;
}

const E: Ep[] = [
  { id: 'H1', method: 'get', path: '/health', role: 'P', tag: 'Health', summary: 'Liveness' },
  { id: 'H2', method: 'get', path: '/ready', role: 'P', tag: 'Health', summary: 'Readiness (DB reachable, migrations current)' },
  { id: 'A1', method: 'post', path: '/auth/login', role: 'P', tag: 'Auth', summary: 'Login with e-mail or username (X-Client: web → refresh token as httpOnly cookie)', body: 'LoginRequest', response: 'LoginResponse' },
  { id: 'A2', method: 'post', path: '/auth/refresh', role: 'P', tag: 'Auth', summary: 'Rotate refresh token (cookie or body); browsers need X-Requested-With + allowed Origin', response: 'LoginResponse' },
  { id: 'A3', method: 'post', path: '/auth/logout', role: 'S', tag: 'Auth', summary: 'Revoke the current session', ok: 204 },
  { id: 'A4', method: 'get', path: '/auth/me', role: 'S', tag: 'Auth', summary: 'Current user', response: 'User' },
  { id: 'A5', method: 'post', path: '/auth/change-password', role: 'S', tag: 'Auth', summary: 'Change own password (other sessions revoked)' },
  { id: 'A6', method: 'post', path: '/auth/accept-invite', role: 'P', tag: 'Auth', summary: 'Accept invite (single-use, 7 days) and log in', response: 'LoginResponse' },
  { id: 'A7', method: 'post', path: '/auth/forgot-password', role: 'P', tag: 'Auth', summary: 'Request reset link (always 200, no enumeration)' },
  { id: 'A8', method: 'post', path: '/auth/reset-password', role: 'P', tag: 'Auth', summary: 'Set new password with reset token (1 h); revokes all sessions' },
  { id: 'A9', method: 'get', path: '/auth/sessions', role: 'S', tag: 'Auth', summary: 'List own sessions' },
  { id: 'A10', method: 'delete', path: '/auth/sessions/{id}', role: 'S', tag: 'Auth', summary: 'Revoke a session', ok: 204 },
  { id: 'A11', method: 'post', path: '/auth/logout-all', role: 'S', tag: 'Auth', summary: 'Revoke all own sessions', ok: 204 },
  { id: 'O1', method: 'get', path: '/companies', role: 'A', tag: 'Organisation', summary: 'List companies' },
  { id: 'O2', method: 'post', path: '/companies', role: 'A', tag: 'Organisation', summary: 'Create company', ok: 201 },
  { id: 'O3', method: 'patch', path: '/companies/{id}', role: 'A', tag: 'Organisation', summary: 'Update company' },
  { id: 'O4', method: 'get', path: '/hotels', role: 'M', tag: 'Organisation', summary: 'Hotels in the access set' },
  { id: 'O5', method: 'post', path: '/hotels', role: 'A', tag: 'Organisation', summary: 'Create hotel', ok: 201 },
  { id: 'O6', method: 'patch', path: '/hotels/{id}', role: 'A', tag: 'Organisation', summary: 'Update hotel' },
  { id: 'O7', method: 'delete', path: '/hotels/{id}', role: 'A', tag: 'Organisation', summary: 'Soft-delete hotel', ok: 204 },
  { id: 'O8', method: 'get', path: '/hotels/{id}/settings', role: 'M', tag: 'Organisation', summary: 'Hotel settings (effective, with defaults)', response: 'HotelSettings' },
  { id: 'O9', method: 'put', path: '/hotels/{id}/settings', role: 'A', tag: 'Organisation', summary: 'Replace hotel settings (validated)', body: 'HotelSettings', response: 'HotelSettings' },
  { id: 'U1', method: 'get', path: '/users', role: 'M', tag: 'Users', summary: 'List users', query: ['page', 'limit', 'role', 'status'] },
  { id: 'U2', method: 'post', path: '/users', role: 'M', tag: 'Users', summary: 'Create user (invited); e-mail or username', ok: 201 },
  { id: 'U3', method: 'patch', path: '/users/{id}', role: 'M', tag: 'Users', summary: 'Update user (disable revokes sessions)' },
  { id: 'U4', method: 'delete', path: '/users/{id}', role: 'M', tag: 'Users', summary: 'Delete user', ok: 204 },
  { id: 'U5', method: 'post', path: '/users/{id}/invite', role: 'M', tag: 'Users', summary: 'Send invite or return hand-over link (deliver: email | link)' },
  { id: 'U6', method: 'put', path: '/users/{id}/hotel-access', role: 'A', tag: 'Users', summary: 'Set a manager’s hotels (revokes sessions)' },
  { id: 'U7', method: 'post', path: '/users/{id}/password-reset-link', role: 'M', tag: 'Users', summary: 'Manager-issued reset link (1 h)' },
  { id: 'D1', method: 'get', path: '/departments', role: 'S', tag: 'Structure', summary: 'List departments', query: ['hotelId', 'page', 'limit'] },
  { id: 'D2', method: 'post', path: '/departments', role: 'M', tag: 'Structure', summary: 'Create department', ok: 201 },
  { id: 'D3', method: 'patch', path: '/departments/{id}', role: 'M', tag: 'Structure', summary: 'Update department' },
  { id: 'D4', method: 'delete', path: '/departments/{id}', role: 'M', tag: 'Structure', summary: 'Soft-delete (409 while in use)', ok: 204 },
  { id: 'S1', method: 'get', path: '/shifts', role: 'S', tag: 'Structure', summary: 'List shifts', query: ['hotelId', 'departmentId', 'page', 'limit'] },
  { id: 'S2', method: 'post', path: '/shifts', role: 'M', tag: 'Structure', summary: 'Create shift (break warnings)', ok: 201, response: 'Shift' },
  { id: 'S3', method: 'patch', path: '/shifts/{id}', role: 'M', tag: 'Structure', summary: 'Update shift', response: 'Shift' },
  { id: 'S4', method: 'delete', path: '/shifts/{id}', role: 'M', tag: 'Structure', summary: 'Soft-delete (409 with future entries)', ok: 204 },
  { id: 'S5', method: 'get', path: '/shifts/{id}/staffing-requirements', role: 'M', tag: 'Structure', summary: 'Minimum staff per ISO weekday' },
  { id: 'S6', method: 'put', path: '/shifts/{id}/staffing-requirements', role: 'M', tag: 'Structure', summary: 'Replace staffing requirements' },
  { id: 'E1', method: 'get', path: '/employees', role: 'M', tag: 'Employees', summary: 'Employees assigned to a hotel (floating staff included)', query: ['hotelId', 'departmentId', 'status', 'search', 'page', 'limit'] },
  { id: 'E2', method: 'get', path: '/employees/{id}', role: 'M', tag: 'Employees', summary: 'Employee (reduced view for non-home managers)', response: 'Employee' },
  { id: 'E3', method: 'post', path: '/employees', role: 'M', tag: 'Employees', summary: 'Create employee', ok: 201, response: 'Employee' },
  { id: 'E4', method: 'patch', path: '/employees/{id}', role: 'M', tag: 'Employees', summary: 'Update master data (home hotel managers)', response: 'Employee' },
  { id: 'E5', method: 'delete', path: '/employees/{id}', role: 'M', tag: 'Employees', summary: 'Soft-delete', ok: 204 },
  { id: 'E6', method: 'get', path: '/employees/{id}/work-targets', role: 'M', tag: 'Employees', summary: 'Work targets' },
  { id: 'E7', method: 'put', path: '/employees/{id}/work-targets', role: 'M', tag: 'Employees', summary: 'Set work targets' },
  { id: 'E12', method: 'put', path: '/employees/{id}/hotels', role: 'M', tag: 'Employees', summary: 'Hotel assignments and home hotel' },
  { id: 'PH1', method: 'get', path: '/public-holidays', role: 'S', tag: 'Employees', summary: 'Public holidays of a hotel region', query: ['hotelId', 'year'] },
  { id: 'T0', method: 'post', path: '/time-offs/preview', role: 'S', tag: 'Absences', summary: 'Counted days, skipped days, allowance, conflicts' },
  { id: 'T1', method: 'get', path: '/time-offs', role: 'M', tag: 'Absences', summary: 'Absences of a hotel’s employees (other hotels: unavailable only)', query: ['hotelId', 'from', 'to', 'type', 'status'] },
  { id: 'T2', method: 'get', path: '/employees/{id}/time-offs', role: 'S', tag: 'Absences', summary: 'Absences of an employee', query: ['year', 'from', 'to', 'status'] },
  { id: 'T3', method: 'post', path: '/employees/{id}/time-offs', role: 'S', tag: 'Absences', summary: 'Request / create absence', ok: 201, response: 'TimeOff' },
  { id: 'T4', method: 'patch', path: '/time-offs/{id}', role: 'S', tag: 'Absences', summary: 'Approve / reject / cancel / certificate (If-Match)', response: 'TimeOff' },
  { id: 'T5', method: 'delete', path: '/time-offs/{id}', role: 'S', tag: 'Absences', summary: 'Cancel', ok: 204 },
  { id: 'B1', method: 'get', path: '/leave-blackouts', role: 'S', tag: 'Absences', summary: 'Leave blackouts', query: ['hotelId', 'year'] },
  { id: 'B2', method: 'post', path: '/leave-blackouts', role: 'M', tag: 'Absences', summary: 'Create blackout', ok: 201 },
  { id: 'B3', method: 'delete', path: '/leave-blackouts/{id}', role: 'M', tag: 'Absences', summary: 'Delete blackout', ok: 204 },
  { id: 'E9', method: 'get', path: '/employees/{id}/vacation-allowance', role: 'S', tag: 'Absences', summary: 'Vacation allowance and usage', query: ['year'] },
  { id: 'E10', method: 'put', path: '/employees/{id}/vacation-allowance', role: 'M', tag: 'Absences', summary: 'Set allowance (minor minimum warning)' },
  { id: 'C1', method: 'get', path: '/schedules', role: 'S', tag: 'Roster', summary: 'Roster entries (manager) / plan (staff)', query: ['hotelId', 'from', 'to', 'departmentId', 'employeeId', 'status'] },
  { id: 'C2', method: 'get', path: '/schedules/{id}', role: 'S', tag: 'Roster', summary: 'Roster entry', response: 'ScheduleEntry' },
  { id: 'C3', method: 'post', path: '/schedules/validate', role: 'M', tag: 'Roster', summary: 'Dry run: hard blocks + warnings, never writes', body: 'ScheduleCreate', response: 'ScheduleEntry' },
  { id: 'C4', method: 'post', path: '/schedules', role: 'M', tag: 'Roster', summary: 'Create shift / day-off entry (draft)', ok: 201, body: 'ScheduleCreate', response: 'ScheduleEntry' },
  { id: 'C5', method: 'patch', path: '/schedules/{id}', role: 'M', tag: 'Roster', summary: 'Change entry (re-runs all rules; If-Match)', response: 'ScheduleEntry' },
  { id: 'C6', method: 'delete', path: '/schedules/{id}', role: 'M', tag: 'Roster', summary: 'Delete entry → { id, warnings }' },
  { id: 'C7', method: 'get', path: '/schedules/coverage', role: 'M', tag: 'Roster', summary: 'Scheduled vs minimum staff', query: ['hotelId', 'from', 'to', 'departmentId'] },
  { id: 'C8', method: 'post', path: '/schedules/bulk', role: 'M', tag: 'Roster', summary: 'Bulk create (partial | atomic, max 500)' },
  { id: 'C9', method: 'post', path: '/schedules/copy', role: 'M', tag: 'Roster', summary: 'Copy a period as drafts' },
  { id: 'C10', method: 'post', path: '/schedules/publish', role: 'M', tag: 'Roster', summary: 'Publish drafts (all-or-nothing)' },
  { id: 'C11', method: 'post', path: '/schedules/unpublish', role: 'M', tag: 'Roster', summary: 'Back to draft (future dates only)' },
  { id: 'C12', method: 'get', path: '/schedules/candidates', role: 'M', tag: 'Roster', summary: 'Cover finder', query: ['hotelId', 'date', 'shiftId'] },
  { id: 'E8', method: 'get', path: '/employees/{id}/work-summary', role: 'S', tag: 'Roster', summary: 'Planned + credited hours vs targets per week', query: ['from', 'to'] },
  { id: 'K1', method: 'post', path: '/kiosk/pair', role: 'P', tag: 'Kiosk', summary: 'Pair a tablet with a pairing code (device token shown once)' },
  { id: 'K2', method: 'get', path: '/kiosk/roster', role: 'D', tag: 'Kiosk', summary: 'Who can punch now (displayName, status, today’s shifts)', query: ['search'] },
  { id: 'K3', method: 'post', path: '/kiosk/verify', role: 'D', tag: 'Kiosk', summary: 'PIN check → single-use punch token (60 s)' },
  { id: 'K4', method: 'post', path: '/kiosk/punch', role: 'D', tag: 'Kiosk', summary: 'clock_in | clock_out | break_start | break_end (server time)', ok: 201 },
  { id: 'K5', method: 'post', path: '/kiosk/pairing-codes', role: 'M', tag: 'Kiosk', summary: 'Create pairing code (10 min)', ok: 201 },
  { id: 'K6', method: 'get', path: '/kiosk/devices', role: 'M', tag: 'Kiosk', summary: 'List devices', query: ['hotelId'] },
  { id: 'K7', method: 'delete', path: '/kiosk/devices/{id}', role: 'M', tag: 'Kiosk', summary: 'Revoke device', ok: 204 },
  { id: 'P1', method: 'post', path: '/employees/{id}/pin/reset', role: 'M', tag: 'Kiosk', summary: 'Generate a new 6-digit PIN (shown once)' },
  { id: 'P2', method: 'put', path: '/employees/me/pin', role: 'S', tag: 'Kiosk', summary: 'Set own PIN (password confirmation)', ok: 204 },
  { id: 'P3', method: 'post', path: '/employees/{id}/pin/unlock', role: 'M', tag: 'Kiosk', summary: 'Unlock PIN', ok: 204 },
  { id: 'AT1', method: 'get', path: '/attendance', role: 'S', tag: 'Attendance', summary: 'Time entries', query: ['hotelId', 'from', 'to', 'employeeId', 'status', 'anomaly'] },
  { id: 'AT2', method: 'get', path: '/attendance/{id}', role: 'S', tag: 'Attendance', summary: 'Time entry with corrections', response: 'TimeEntry' },
  { id: 'AT3', method: 'post', path: '/attendance', role: 'M', tag: 'Attendance', summary: 'Manual entry (reason mandatory)', ok: 201, response: 'TimeEntry' },
  { id: 'AT4', method: 'patch', path: '/attendance/{id}', role: 'M', tag: 'Attendance', summary: 'Direct change → approved correction row', response: 'TimeEntry' },
  { id: 'AT5', method: 'post', path: '/attendance/{id}/corrections', role: 'S', tag: 'Attendance', summary: 'Request correction (reason mandatory)', ok: 201 },
  { id: 'AT6', method: 'get', path: '/attendance/corrections', role: 'S', tag: 'Attendance', summary: 'Corrections', query: ['hotelId', 'status'] },
  { id: 'AT7', method: 'patch', path: '/attendance/corrections/{id}', role: 'S', tag: 'Attendance', summary: 'Approve / reject / cancel' },
  { id: 'AT8', method: 'get', path: '/attendance/live', role: 'M', tag: 'Attendance', summary: 'Live board', query: ['hotelId', 'departmentId'] },
  { id: 'AT9', method: 'put', path: '/hotels/{id}/attendance-lock', role: 'M', tag: 'Attendance', summary: 'Period lock (managers forward only)' },
  { id: 'AT10', method: 'get', path: '/attendance/export', role: 'M', tag: 'Attendance', summary: 'CSV, one line per time entry', query: ['hotelId', 'from', 'to', 'format'] },
  { id: 'AT11', method: 'get', path: '/hotels/{id}/payroll-export', role: 'M', tag: 'Attendance', summary: 'Payroll export (json | csv | datev)', query: ['month', 'format'] },
  { id: 'E13', method: 'get', path: '/employees/{id}/time-account', role: 'S', tag: 'Attendance', summary: 'Monthly time account', query: ['from', 'to'] },
  { id: 'W1', method: 'get', path: '/shift-wishes', role: 'S', tag: 'Wishes', summary: 'Shift wishes', query: ['hotelId', 'from', 'to', 'status', 'employeeId'] },
  { id: 'W2', method: 'post', path: '/employees/{id}/shift-wishes', role: 'S', tag: 'Wishes', summary: 'Create shift / day-off wish', ok: 201 },
  { id: 'W3', method: 'patch', path: '/shift-wishes/{id}', role: 'S', tag: 'Wishes', summary: 'Decide / withdraw' },
  { id: 'W4', method: 'get', path: '/leave-wishes', role: 'S', tag: 'Wishes', summary: 'Leave wishes', query: ['hotelId', 'from', 'to', 'status', 'employeeId'] },
  { id: 'W5', method: 'post', path: '/employees/{id}/leave-wishes', role: 'S', tag: 'Wishes', summary: 'Create leave wish', ok: 201 },
  { id: 'W6', method: 'patch', path: '/leave-wishes/{id}', role: 'S', tag: 'Wishes', summary: 'Decide / withdraw' },
  { id: 'W7', method: 'get', path: '/hotels/{id}/planning-dashboard', role: 'M', tag: 'Wishes', summary: 'Wishes with coverage risk', query: ['from', 'to'] },
  { id: 'PO1', method: 'get', path: '/me/dashboard', role: 'S', tag: 'Portal', summary: 'Employee dashboard' },
  { id: 'PR1', method: 'get', path: '/me/profile', role: 'S', tag: 'Portal', summary: 'Own profile' },
  { id: 'PR2', method: 'patch', path: '/me/profile', role: 'S', tag: 'Portal', summary: 'Update phone / language' },
  { id: 'NT1', method: 'get', path: '/notifications', role: 'S', tag: 'Portal', summary: 'Notifications', query: ['unread', 'page', 'limit'] },
  { id: 'NT2', method: 'patch', path: '/notifications/{id}', role: 'S', tag: 'Portal', summary: 'Mark read / unread' },
  { id: 'NT3', method: 'post', path: '/notifications/read-all', role: 'S', tag: 'Portal', summary: 'Mark all read' },
  { id: 'NT4', method: 'get', path: '/me/notification-preferences', role: 'S', tag: 'Portal', summary: 'E-mail preferences per kind' },
  { id: 'NT5', method: 'put', path: '/me/notification-preferences', role: 'S', tag: 'Portal', summary: 'Set e-mail preferences' },
  { id: 'IN1', method: 'post', path: '/inquiries', role: 'S', tag: 'Inquiries', summary: 'Ask the managers (routed by related entry or home hotel)', ok: 201 },
  { id: 'IN2', method: 'get', path: '/inquiries', role: 'S', tag: 'Inquiries', summary: 'List inquiries', query: ['status', 'hotelId', 'page', 'limit'] },
  { id: 'IN3', method: 'get', path: '/inquiries/{id}', role: 'S', tag: 'Inquiries', summary: 'Inquiry with messages' },
  { id: 'IN4', method: 'post', path: '/inquiries/{id}/messages', role: 'S', tag: 'Inquiries', summary: 'Reply', ok: 201 },
  { id: 'IN5', method: 'patch', path: '/inquiries/{id}', role: 'S', tag: 'Inquiries', summary: 'Close / reopen / assign' },
  { id: 'N1', method: 'get', path: '/hotels/{id}/analytics/absences', role: 'M', tag: 'Analytics', summary: 'Sick-leave analytics (Bradford factor)', query: ['from', 'to', 'departmentId'] },
  { id: 'N2', method: 'get', path: '/hotels/{id}/analytics/absences/trend', role: 'M', tag: 'Analytics', summary: 'Monthly sick-leave trend', query: ['from', 'to', 'granularity'] },
  { id: 'N3', method: 'get', path: '/hotels/{id}/analytics/hours', role: 'M', tag: 'Analytics', summary: 'Hours vs targets', query: ['month'] },
  { id: 'N4', method: 'get', path: '/audit-logs', role: 'M', tag: 'Analytics', summary: 'Audit log (PII-free)', query: ['hotelId', 'entityType', 'entityId', 'userId', 'action', 'from', 'to', 'page', 'limit'] },
  { id: 'N5', method: 'get', path: '/hotels/{id}/analytics/attendance', role: 'M', tag: 'Analytics', summary: 'Attendance analytics', query: ['from', 'to'] },
  { id: 'N6', method: 'get', path: '/analytics/overview', role: 'M', tag: 'Analytics', summary: 'Cross-hotel overview', query: ['hotelIds', 'from', 'to'] },
  { id: 'E11', method: 'post', path: '/employees/{id}/anonymize', role: 'A', tag: 'Analytics', summary: 'Anonymise a terminated employee (force + reason before retention)' },
];

const roleText: Record<Role, string> = { P: 'public', S: 'staff and up', M: 'manager and up', A: 'admin', D: 'kiosk device token' };
const paramDesc: Record<string, string> = {
  hotelId: 'Hotel id; required when the caller can access more than one hotel',
  from: 'YYYY-MM-DD (month endpoints: YYYY-MM)',
  to: 'YYYY-MM-DD (month endpoints: YYYY-MM)',
  employeeId: "Employee id or 'me'",
  page: 'Page (default 1)',
  limit: 'Page size (default 50, max 100)',
};

const errorRef = (d: string) => ({ description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });

const paths: Record<string, any> = {};
for (const e of E) {
  const p = (paths[e.path] ??= {});
  const params: any[] = [];
  if (e.path.includes('{id}')) params.push({ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: "Numeric id ('me' allowed for /employees/{id}/...)" });
  for (const qn of e.query ?? []) params.push({ name: qn, in: 'query', required: false, schema: { type: 'string' }, ...(paramDesc[qn] ? { description: paramDesc[qn] } : {}) });
  const ok = e.ok ?? 200;
  const responses: any = {
    [ok]: ok === 204 ? { description: 'No content' } : { description: 'OK', content: { 'application/json': { schema: e.response ? { $ref: `#/components/schemas/${e.response}` } : { type: 'object' } } } },
    400: errorRef('VALIDATION_ERROR'),
    404: errorRef('RESOURCE_NOT_FOUND'),
  };
  if (e.role !== 'P') {
    responses[401] = errorRef('UNAUTHENTICATED / DEVICE_UNAUTHORIZED');
    responses[403] = errorRef('FORBIDDEN');
  }
  if (['post', 'patch', 'put', 'delete'].includes(e.method)) {
    responses[409] = errorRef('Conflict');
    responses[422] = errorRef('Business rule violated');
  }
  if (e.method === 'patch') responses[412] = errorRef('PRECONDITION_FAILED (If-Match)');
  p[e.method] = {
    operationId: e.id,
    tags: [e.tag],
    summary: `${e.id}: ${e.summary}`,
    description: `Role: ${roleText[e.role]}.`,
    security: e.role === 'P' ? [] : e.role === 'D' ? [{ deviceToken: [] }] : [{ bearer: [] }],
    ...(params.length ? { parameters: params } : {}),
    ...(['post', 'patch', 'put'].includes(e.method)
      ? { requestBody: { required: false, content: { 'application/json': { schema: e.body ? { $ref: `#/components/schemas/${e.body}` } : { type: 'object' } } } } }
      : {}),
    responses,
  };
}

const doc = {
  openapi: '3.1.0',
  info: {
    title: 'Shift Scheduler & Attendance API',
    version: '2.4.0',
    description: 'Backend of docs/SPEC.md v2.4. Error envelope: { error: { code, message, details?, requestId } }. Lists: { data, meta: { page, limit, total } }. Calendar endpoints are range based (max 62 days).',
  },
  servers: [{ url: '/api/v1' }],
  tags: [...new Set(E.map((e) => e.tag))].map((name) => ({ name })),
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      deviceToken: { type: 'apiKey', in: 'header', name: 'X-Device-Token' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: {
              code: { type: 'string', example: 'EMPLOYEE_ON_TIME_OFF' },
              message: { type: 'string' },
              details: { type: 'array', items: { type: 'object' } },
              requestId: { type: 'string' },
            },
          },
        },
      },
      LoginRequest: { type: 'object', required: ['login', 'password'], properties: { login: { type: 'string', description: 'e-mail or username' }, password: { type: 'string' } } },
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, email: { type: ['string', 'null'] }, username: { type: ['string', 'null'] }, firstName: { type: ['string', 'null'] },
          role: { enum: ['staff', 'manager', 'admin'] }, hotelIds: { type: 'array', items: { type: 'integer' } }, employeeId: { type: ['integer', 'null'] }, preferredLanguage: { enum: ['de', 'en'] },
        },
      },
      LoginResponse: {
        type: 'object',
        properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string', description: 'absent for X-Client: web (cookie instead)' }, expiresIn: { type: 'integer', example: 900 }, user: { $ref: '#/components/schemas/User' } },
      },
      Shift: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, hotelId: { type: 'integer' }, departmentId: { type: 'integer' }, name: { type: 'string' }, startTime: { type: 'string', example: '06:00' }, endTime: { type: 'string' },
          durationHours: { type: 'number' }, breakDurationMinutes: { type: 'integer' }, paidHours: { type: 'number' }, warnings: { type: 'array', items: { $ref: '#/components/schemas/Warning' } },
        },
      },
      Warning: { type: 'object', properties: { type: { type: 'string' }, severity: { enum: ['warning', 'info'] }, message: { type: 'string' } }, additionalProperties: true },
      Employee: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, employeeNumber: { type: ['string', 'null'] }, firstName: { type: 'string' }, lastName: { type: 'string' }, email: { type: ['string', 'null'] }, phone: { type: ['string', 'null'] },
          hourlyRate: { type: ['number', 'null'] }, payType: { enum: ['salary', 'hourly'], description: 'required on create' }, publicHolidaysOff: { type: 'boolean', default: true }, status: { enum: ['active', 'on_leave', 'terminated'] }, employmentType: { type: 'string' }, birthDate: { type: ['string', 'null'] }, hiredOn: { type: ['string', 'null'] },
          attendanceRequired: { type: 'boolean' }, workWeekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 } }, terminatedOn: { type: ['string', 'null'] }, homeHotelId: { type: 'integer' },
          hotels: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, isHome: { type: 'boolean' } } } },
          departments: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, color: { type: ['string', 'null'] }, hotelId: { type: 'integer' } } } },
        },
      },
      TimeOff: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, employeeId: { type: 'integer' }, type: { enum: ['annual_leave', 'sick_leave', 'unpaid_leave', 'school', 'other'] }, startDate: { type: 'string' }, endDate: { type: 'string' },
          startHalfDay: { type: 'boolean' }, endHalfDay: { type: 'boolean' }, timeOffDays: { type: 'number' }, reason: { type: ['string', 'null'] }, status: { enum: ['pending', 'approved', 'rejected', 'cancelled'] },
          medicalCertificateReceived: { type: 'boolean' }, decidedById: { type: ['integer', 'null'] }, decidedAt: { type: ['string', 'null'] }, conflicts: { type: 'array', items: { type: 'integer' } },
        },
      },
      ScheduleCreate: {
        type: 'object',
        required: ['employeeId', 'date'],
        properties: {
          hotelId: { type: 'integer' }, entryType: { enum: ['shift', 'off'] }, employeeId: { type: 'integer' }, shiftId: { type: ['integer', 'null'] }, date: { type: 'string' }, offLabel: { type: ['string', 'null'] },
          overrideReason: { type: ['string', 'null'] }, wishId: { type: 'integer' }, allowPast: { type: 'boolean', description: 'admin only' },
        },
      },
      ScheduleEntry: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, status: { enum: ['draft', 'published'] }, entryType: { enum: ['shift', 'off'] }, date: { type: 'string' }, employee: { type: 'object' }, shift: { $ref: '#/components/schemas/Shift' },
          offLabel: { type: ['string', 'null'] }, paidHoursAssigned: { type: 'number' }, currentWeekHours: { type: 'number' }, currentMonthHours: { type: 'number' }, weeklyTarget: { type: 'number' }, monthlyTarget: { type: 'number' },
          restPeriodHours: { type: ['number', 'null'] }, warnings: { type: 'array', items: { $ref: '#/components/schemas/Warning' } }, overrideReason: { type: ['string', 'null'] }, publishedAt: { type: ['string', 'null'] },
        },
      },
      TimeEntry: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, employeeId: { type: 'integer' }, scheduleId: { type: ['integer', 'null'] }, status: { enum: ['open', 'closed', 'needs_review'] }, clockInAt: { type: 'string' }, clockOutAt: { type: ['string', 'null'] },
          breakMinutes: { type: 'integer' }, workedMinutes: { type: ['integer', 'null'] }, sourceIn: { enum: ['kiosk', 'manager'] }, sourceOut: { type: ['string', 'null'] }, anomalies: { type: 'array', items: { type: 'object' } },
          note: { type: ['string', 'null'] }, corrections: { type: 'array', items: { type: 'object' } },
        },
      },
      HotelSettings: { type: 'object', description: 'See spec section 4 (legal, roster, portal, wishes, attendance, absence, payroll, retention)', additionalProperties: true },
    },
  },
  paths,
};

const out = path.resolve(__dirname, '..', 'openapi.yaml');
fs.writeFileSync(out, `# Generated by scripts/gen-openapi.ts from the endpoint catalog in docs/SPEC.md section 8.\n${YAML.stringify(doc, { lineWidth: 0 })}`);
console.log(`wrote ${out} (${E.length} operations)`);
