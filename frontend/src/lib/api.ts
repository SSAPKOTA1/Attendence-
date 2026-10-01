/** Thin fetch client for /api/v1: access token in memory, refresh cookie (web) with single-flight rotation. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any[], public extra?: Record<string, any>) {
    super(message);
  }
}

const BASE = '/api/v1';
let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
let onSessionLost: () => void = () => {};

let lang = 'de';
export const setApiLanguage = (l: string) => { lang = l; };
export const setAccessToken = (t: string | null) => { accessToken = t; };
export const getAccessToken = () => accessToken;
export const setSessionLostHandler = (fn: () => void) => { onSessionLost = fn; };

const DEVICE_KEY = 'kiosk.deviceToken';
const HOTEL_KEY = 'kiosk.hotel';
export const kioskHotel = {
  get: (): { name: string; timezone: string } => { try { return JSON.parse(localStorage.getItem(HOTEL_KEY) ?? 'null') ?? { name: '', timezone: 'Europe/Berlin' }; } catch { return { name: '', timezone: 'Europe/Berlin' }; } },
  set: (h: { name: string; timezone: string }) => { try { localStorage.setItem(HOTEL_KEY, JSON.stringify(h)); } catch { /* private mode */ } },
};
export const deviceToken = {
  get: () => { try { return localStorage.getItem(DEVICE_KEY); } catch { return null; } },
  set: (t: string) => { try { localStorage.setItem(DEVICE_KEY, t); } catch { /* private mode */ } },
  clear: () => { try { localStorage.removeItem(DEVICE_KEY); } catch { /* private mode */ } },
};

type Opts = { blob?: boolean; body?: unknown; query?: Record<string, unknown>; device?: boolean; noAuth?: boolean; raw?: boolean; headers?: Record<string, string>; retry?: boolean };

function qs(query?: Record<string, unknown>) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function toError(res: Response): Promise<ApiError> {
  let body: any = null;
  try { body = await res.json(); } catch { /* not json */ }
  const e = body?.error ?? {};
  const { code, message, details, ...extra } = e;
  return new ApiError(res.status, code ?? 'HTTP_' + res.status, message ?? res.statusText, details, extra);
}

/** Refresh tokens are single-use (reuse revokes the session), so tabs of the same browser must take turns. */
const exclusively = <T>(fn: () => Promise<T>): Promise<T> => (typeof navigator !== 'undefined' && navigator.locks ? (navigator.locks.request('refresh-session', fn) as Promise<T>) : fn());

/** Rotate the refresh cookie; resolves with the new access token or null (session over). */
export function refreshSession(): Promise<string | null> {
  refreshing ??= exclusively(async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST', credentials: 'include',
        headers: { 'X-Client': 'web', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!res.ok) return null;
      const data = await res.json();
      accessToken = data.accessToken;
      return accessToken;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  });
  return refreshing;
}

export async function api<T = any>(method: string, path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Client': 'web', 'X-Requested-With': 'XMLHttpRequest', 'Accept-Language': lang, ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.device) { const d = deviceToken.get(); if (d) headers['X-Device-Token'] = d; }
  else if (!opts.noAuth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${BASE}${path}${qs(opts.query)}`, {
    method, headers, credentials: 'include', body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401 && !opts.device && !opts.noAuth && !opts.retry) {
    const err = await toError(res);
    if (err.code === 'TOKEN_EXPIRED' || err.code === 'UNAUTHENTICATED') {
      if (await refreshSession()) return api<T>(method, path, { ...opts, retry: true });
      accessToken = null;
      onSessionLost();
    }
    throw err;
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  if (opts.blob) return (await res.blob()) as T;
  if (opts.raw) return (await res.text()) as T;
  return (await res.json()) as T;
}

export const get = <T = any>(path: string, query?: Record<string, unknown>, o: Opts = {}) => api<T>('GET', path, { ...o, query });
export const post = <T = any>(path: string, body?: unknown, o: Opts = {}) => api<T>('POST', path, { ...o, body: body ?? {} });
export const patch = <T = any>(path: string, body?: unknown, o: Opts = {}) => api<T>('PATCH', path, { ...o, body: body ?? {} });
export const put = <T = any>(path: string, body?: unknown, o: Opts = {}) => api<T>('PUT', path, { ...o, body: body ?? {} });
export const del = <T = any>(path: string, o: Opts = {}) => api<T>('DELETE', path, o);

/** Download a file endpoint (exports); goes through api() so an expired access token is refreshed first. */
export async function download(path: string, query: Record<string, unknown>, filename: string) {
  const blob = await api<Blob>('GET', path, { query, blob: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/** Follow page/limit pagination until everything is loaded (API max page size is 100). */
export async function getAll<T = any>(path: string, query: Record<string, unknown> = {}): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page < 50; page++) {
    const r = await get<{ data: T[]; meta?: { total: number } }>(path, { ...query, page, limit: 100 });
    out.push(...r.data);
    // some lists (attendance, wishes) are not paginated and come back whole without meta
    if (!r.meta || out.length >= r.meta.total || r.data.length === 0) break;
  }
  return out;
}
