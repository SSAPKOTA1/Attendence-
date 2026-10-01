import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { ErrorBox, Field, Loading, Section, Tag } from '../components/ui';

const PREF_LABEL: Record<string, string> = {
  roster_published: 'Dienstplan veröffentlicht', roster_entry_changed: 'Dienst geändert', roster_entry_removed: 'Dienst entfernt', absence_decided: 'Abwesenheit entschieden',
  wish_decided: 'Wunsch entschieden', correction_decided: 'Korrektur entschieden', inquiry_reply: 'Antwort auf Frage', time_approval_decided: 'Arbeitszeit entschieden',
};

export default function Profile() {
  const { t, setLang } = useI18n();
  const { user } = useAuth();
  const qc = useQueryClient();
  const hasEmployee = !!user?.employeeId;
  const profile = useQuery({ queryKey: ['me', 'profile'], queryFn: () => get('/me/profile'), enabled: hasEmployee });
  const prefs = useQuery({ queryKey: ['me', 'prefs'], queryFn: () => get('/me/notification-preferences') });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get('/auth/sessions').then((r) => (Array.isArray(r) ? r : r.data)) });
  const [phone, setPhone] = useState<string | null>(null);
  const saveProfile = useMutation({
    mutationFn: (b: any) => patch('/me/profile', b),
    onSuccess: (_r, b) => { if (b.preferredLanguage) setLang(b.preferredLanguage); qc.invalidateQueries({ queryKey: ['me', 'profile'] }); },
  });
  const savePrefs = useMutation({ mutationFn: (b: any) => put('/me/notification-preferences', b), onSuccess: () => qc.invalidateQueries({ queryKey: ['me', 'prefs'] }) });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/auth/sessions/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }) });
  const logoutAll = useMutation({ mutationFn: () => post('/auth/logout-all'), onSuccess: () => window.location.assign('/login') });

  const [cur, setCur] = useState('');
  const [npw, setNpw] = useState('');
  const changePw = useMutation({ mutationFn: () => post('/auth/change-password', { currentPassword: cur, newPassword: npw }), onSuccess: () => { setCur(''); setNpw(''); } });
  const [pinPw, setPinPw] = useState('');
  const [pin, setPin] = useState('');
  const changePin = useMutation({ mutationFn: () => put('/employees/me/pin', { currentPassword: pinPw, newPin: pin }), onSuccess: () => { setPinPw(''); setPin(''); } });
  const p = profile.data;
  const p2 = (e: FormEvent, fn: () => void) => { e.preventDefault(); fn(); };
  return (
    <div className="page">
      <header className="page-head"><div><div className="kicker">{user?.email ?? user?.username}</div><h1>{t('Profil')}</h1></div></header>
      {hasEmployee && (
        <Section title={t('Meine Daten')}>
          {profile.isLoading ? <Loading /> : p && (
            <dl className="facts">
              <dt>{t('Name')}</dt><dd>{p.firstName} {p.lastName}</dd>
              <dt>{t('Personalnummer')}</dt><dd>{p.employeeNumber ?? '–'}</dd>
              <dt>{t('Stammhaus')}</dt><dd>{p.homeHotel?.name}</dd>
              <dt>{t('Abteilungen')}</dt><dd>{(p.departments ?? []).map((d: any) => d.name).join(', ') || '–'}</dd>
            </dl>
          )}
          <form className="stack form-narrow" onSubmit={(e) => p2(e, () => saveProfile.mutate({ phone: (phone ?? p?.phone ?? '') || null }))}>
            <Field label={t('Telefon')}>{(i) => <input id={i} className="input" value={phone ?? p?.phone ?? ''} onChange={(e) => setPhone(e.target.value)} />}</Field>
            <button className="btn btn-secondary self-start" disabled={saveProfile.isPending}>{t('Speichern')}</button>
          </form>
        </Section>
      )}
      <Section title={t('Sprache')}>
        <div className="seg" role="group" aria-label={t('Sprache')}>
          {(['de', 'en'] as const).map((l) => (
            <button key={l} className={`seg-btn${user?.preferredLanguage === l ? ' is-on' : ''}`} onClick={() => (hasEmployee ? saveProfile.mutate({ preferredLanguage: l }) : setLang(l))}>{l === 'de' ? 'Deutsch' : 'English'}</button>
          ))}
        </div>
      </Section>
      <Section title={t('E-Mail-Benachrichtigungen')}>
        {prefs.isLoading ? <Loading /> : (
          <ul className="plain">
            {Object.entries(PREF_LABEL).map(([k, label]) => (
              <li key={k}><label className="check">
                <input type="checkbox" checked={prefs.data?.[k]?.email ?? false} onChange={(e) => savePrefs.mutate({ ...prefs.data, [k]: { email: e.target.checked } })} /> {t(label)}
              </label></li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t('Passwort ändern')}>
        <form className="stack form-narrow" onSubmit={(e) => p2(e, () => changePw.mutate())}>
          <Field label={t('Aktuelles Passwort')}>{(i) => <input id={i} className="input" type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} />}</Field>
          <Field label={t('Neues Passwort')} hint={t('mindestens 10 Zeichen')}>{(i) => <input id={i} className="input" type="password" minLength={10} autoComplete="new-password" required value={npw} onChange={(e) => setNpw(e.target.value)} />}</Field>
          <ErrorBox error={changePw.error} />
          {changePw.isSuccess && <p className="ok" role="status">{t('Passwort geändert.')}</p>}
          <button className="btn btn-secondary self-start" disabled={changePw.isPending}>{t('Passwort ändern')}</button>
        </form>
      </Section>
      {hasEmployee && (
        <Section title={t('Tablet-PIN')}>
          <form className="stack form-narrow" onSubmit={(e) => p2(e, () => changePin.mutate())}>
            <Field label={t('Passwort')}>{(i) => <input id={i} className="input" type="password" required value={pinPw} onChange={(e) => setPinPw(e.target.value)} />}</Field>
            <Field label={t('Neue PIN (6 Ziffern)')}>{(i) => <input id={i} className="input" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />}</Field>
            <ErrorBox error={changePin.error} />
            {changePin.isSuccess && <p className="ok" role="status">{t('PIN geändert.')}</p>}
            <button className="btn btn-secondary self-start" disabled={changePin.isPending || pin.length !== 6}>{t('PIN ändern')}</button>
          </form>
        </Section>
      )}
      <Section title={t('Angemeldete Geräte')} aside={<button className="btn btn-ghost" onClick={() => logoutAll.mutate()}>{t('Überall abmelden')}</button>}>
        <table className="table"><tbody>
          {(sessions.data ?? []).map((s: any) => (
            <tr key={s.id}><td className="small">{s.userAgent ?? '–'}</td><td className="muted small">{s.ip}</td>
              <td>{s.current ? <Tag kind="accent">{t('Dieses Gerät')}</Tag> : <button className="btn btn-ghost" onClick={() => revoke.mutate(s.id)}>{t('Abmelden')}</button>}</td></tr>
          ))}
        </tbody></table>
      </Section>
    </div>
  );
}
