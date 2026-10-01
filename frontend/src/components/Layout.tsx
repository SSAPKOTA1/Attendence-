import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { isManager, useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useHotel } from './hotel';

export default function Layout() {
  const { user, logout } = useAuth();
  const { t, lang, setLang } = useI18n();
  const { hotels, hotel, setHotelId } = useHotel();
  const manager = isManager(user);
  const unread = useQuery({
    queryKey: ['notifications', 'unread'], enabled: !!user, refetchInterval: 60_000,
    queryFn: () => get('/notifications', { unread: true, limit: 1 }).then((r) => r.meta?.unread ?? 0),
  });
  const item = (to: string, label: string, badge?: number) => (
    <NavLink key={to} to={to} className={({ isActive }) => `navbtn${isActive ? ' is-active' : ''}`}>
      {label}{badge ? <span className="badge" aria-label={t('ungelesen')}>{badge}</span> : null}
    </NavLink>
  );
  return (
    <div className="shell">
      <header className="nav shell-nav">
        <div className="nav-brand">Trip Inn<span className="brand-sub">{t('Dienstplan & Zeiterfassung')}</span></div>
        <nav className="navlist" aria-label={t('Hauptnavigation')}>
          {manager && <>
            {item('/manage/roster', t('Dienstplan'))}
            {item('/manage/live', t('Live'))}
            {item('/manage/requests', t('Anträge'))}
            {item('/manage/staff', t('Mitarbeiter'))}
            {item('/manage/inquiries', t('Fragen'))}
            {item('/manage/attendance', t('Zeiten'))}
            {item('/manage/analytics', t('Auswertung'))}
            {item('/manage/devices', t('Tablet & Export'))}
            {item('/manage/setup', t('Einrichtung'))}
          </>}
          {user?.employeeId && <>
            {item('/portal', manager ? t('Mein Portal') : t('Übersicht'))}
            {item('/portal/schedule', t('Mein Dienstplan'))}
            {item('/portal/time-off', t('Urlaub & Abwesenheit'))}
            {item('/portal/wishes', t('Wünsche'))}
            {item('/portal/attendance', t('Meine Zeiten'))}
            {!manager && item('/portal/inquiries', t('Fragen'))}
          </>}
          {item('/notifications', t('Mitteilungen'), unread.data)}
          {item('/profile', t('Profil'))}
        </nav>
        <div className="navtools">
          {manager && hotels.length > 1 && (
            <select aria-label={t('Hotel')} className="input compact" value={hotel?.id ?? ''} onChange={(e) => setHotelId(Number(e.target.value))}>
              {hotels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          )}
          <div className="seg" role="group" aria-label={t('Sprache')}>
            {(['de', 'en'] as const).map((l) => (
              <button key={l} className={`seg-btn${lang === l ? ' is-on' : ''}`} aria-pressed={lang === l} onClick={() => setLang(l)}>{l.toUpperCase()}</button>
            ))}
          </div>
          <span className="muted who">{user?.firstName}</span>
          <button className="btn btn-ghost" onClick={logout}>{t('Abmelden')}</button>
        </div>
      </header>
      <main className="shell-main"><Outlet /></main>
    </div>
  );
}
