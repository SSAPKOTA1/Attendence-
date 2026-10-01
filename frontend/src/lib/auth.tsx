import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { get, post, refreshSession, setAccessToken, setSessionLostHandler } from './api';
import { useI18n } from './i18n';
import type { User } from './types';

interface AuthCtx {
  user: User | null;
  status: 'loading' | 'anon' | 'authed';
  login: (login: string, password: string) => Promise<User>;
  acceptInvite: (token: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthCtx['status']>('loading');
  const qc = useQueryClient();
  const { setLang } = useI18n();

  const accept = useCallback((u: User) => { setUser(u); setStatus('authed'); if (u.preferredLanguage) setLang(u.preferredLanguage); return u; }, [setLang]);
  const drop = useCallback(() => { setAccessToken(null); setUser(null); setStatus('anon'); qc.clear(); }, [qc]);

  useEffect(() => {
    setSessionLostHandler(drop);
    let alive = true;
    (async () => {
      if (!(await refreshSession())) { if (alive) setStatus('anon'); return; }
      try { const me = await get<User>('/auth/me'); if (alive) accept(me); } catch { if (alive) drop(); }
    })();
    return () => { alive = false; };
  }, [accept, drop]);

  const value = useMemo<AuthCtx>(() => ({
    user, status,
    login: async (login, password) => {
      const r = await post('/auth/login', { login, password }, { noAuth: true });
      setAccessToken(r.accessToken);
      return accept(r.user);
    },
    acceptInvite: async (token, password) => {
      const r = await post('/auth/accept-invite', { token, password }, { noAuth: true });
      setAccessToken(r.accessToken);
      return accept(r.user);
    },
    logout: async () => { try { await post('/auth/logout'); } catch { /* already gone */ } drop(); },
  }), [user, status, accept, drop]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
export const isManager = (u: User | null) => !!u && u.role !== 'staff';
