import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { ErrorBox, Field } from '../components/ui';

function Split({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="login">
      <section className="login-brand">
        <div className="kicker">Trip Inn Hotels</div>
        <h1>{t('Dienstplan & Zeiterfassung')}</h1>
      </section>
      <section className="login-form">
        <div className="seg lang-corner" role="group" aria-label={t('Sprache')}>
          {(['de', 'en'] as const).map((l) => <button key={l} className={`seg-btn${lang === l ? ' is-on' : ''}`} onClick={() => setLang(l)}>{l.toUpperCase()}</button>)}
        </div>
        {children}
      </section>
    </div>
  );
}

export function LoginPage() {
  const { t } = useI18n();
  const { login, user, status } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (status === 'authed' && user) return <Navigate to={loc.state?.from ?? '/'} replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await login(id.trim(), pw); nav(loc.state?.from ?? '/', { replace: true }); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Split>
      <form onSubmit={submit} className="stack" aria-label={t('Anmelden')}>
        <h2>{t('Anmelden')}</h2>
        <Field label={t('E-Mail oder Benutzername')}>{(i) => <input id={i} className="input" autoComplete="username" required value={id} onChange={(e) => setId(e.target.value)} />}</Field>
        <Field label={t('Passwort')}>{(i) => <input id={i} className="input" type="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
        <ErrorBox error={err} />
        <button className="btn btn-primary btn-block" disabled={busy}>{t('Anmelden')}</button>
        <Link className="btn btn-ghost self-start" to="/forgot-password">{t('Passwort vergessen?')}</Link>
        <Link className="muted small" to="/kiosk">{t('Dies ist ein Stempel-Tablet →')}</Link>
      </form>
    </Split>
  );
}

export function ForgotPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    try { await post('/auth/forgot-password', { email }, { noAuth: true }); setDone(true); } catch (x) { setErr(x); }
  };
  return (
    <Split>
      <form onSubmit={submit} className="stack">
        <h2>{t('Passwort zurücksetzen')}</h2>
        {done ? (
          <p role="status">{t('Wenn ein Konto zu dieser E-Mail-Adresse existiert, ist ein Link unterwegs.')}</p>
        ) : (
          <>
            <p className="muted small">{t('Ohne E-Mail-Adresse: Bitte deine Leitung um einen Link zum Zurücksetzen.')}</p>
            <Field label={t('E-Mail')}>{(i) => <input id={i} className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <ErrorBox error={err} />
            <button className="btn btn-primary btn-block">{t('Link senden')}</button>
          </>
        )}
        <Link className="btn btn-ghost self-start" to="/login">{t('Zurück zur Anmeldung')}</Link>
      </form>
    </Split>
  );
}

/** Shared by /accept-invite and /reset-password: both take ?token and a new password. */
export function SetPasswordPage({ mode }: { mode: 'invite' | 'reset' }) {
  const { t } = useI18n();
  const { acceptInvite } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const mismatch = pw2.length > 0 && pw !== pw2;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    try {
      if (mode === 'invite') { await acceptInvite(token, pw); nav('/', { replace: true }); }
      else { await post('/auth/reset-password', { token, password: pw }, { noAuth: true }); setDone(true); }
    } catch (x) { setErr(x); }
  };
  return (
    <Split>
      <form onSubmit={submit} className="stack">
        <h2>{mode === 'invite' ? t('Konto aktivieren') : t('Neues Passwort')}</h2>
        {done ? (
          <>
            <p role="status">{t('Passwort geändert. Du kannst dich jetzt anmelden.')}</p>
            <Link className="btn btn-primary" to="/login">{t('Anmelden')}</Link>
          </>
        ) : (
          <>
            {!token && <div className="error-box" role="alert">{t('Der Link ist ungültig.')}</div>}
            <Field label={t('Neues Passwort')} hint={t('mindestens 10 Zeichen')}>{(i) => <input id={i} className="input" type="password" minLength={10} autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
            <Field label={t('Passwort wiederholen')}>{(i) => <input id={i} className="input" type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
            {mismatch && <div className="error-box" role="alert">{t('Die Passwörter stimmen nicht überein.')}</div>}
            <ErrorBox error={err} />
            <button className="btn btn-primary btn-block" disabled={!token || mismatch || pw.length < 10}>{t('Speichern')}</button>
          </>
        )}
      </form>
    </Split>
  );
}
