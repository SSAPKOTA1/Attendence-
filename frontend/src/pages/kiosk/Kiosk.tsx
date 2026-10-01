import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError, deviceToken, get, kioskHotel, post } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { fmtTime } from '../../lib/format';
import { ErrorBox } from '../../components/ui';

type Step = { kind: 'list' } | { kind: 'pin'; emp: any } | { kind: 'action'; emp: any; v: any } | { kind: 'done'; res: any; action: string };
const STATUS: Record<string, string> = { not_in: 'Nicht da', in: 'Eingestempelt', on_break: 'In der Pause' };
const ACTION: Record<string, string> = { clock_in: 'Einstempeln', clock_out: 'Ausstempeln', break_start: 'Pause starten', break_end: 'Pause beenden' };
const ANOMALY: Record<string, string> = {
  late_clock_in: 'Du bist später als geplant.', early_clock_in: 'Du bist früher als geplant.', early_clock_out: 'Du gehst früher als geplant.', overtime: 'Du hast länger gearbeitet als geplant.',
  unscheduled_work: 'Ungeplanter Dienst – deine Leitung prüft die Zeit.', missing_break: 'Pause fehlt.', minor_outside_hours: 'Achtung: Jugendschutz.', minor_limit_exceeded: 'Achtung: Jugendschutz.',
};

export default function Kiosk() {
  const [paired, setPaired] = useState(() => !!deviceToken.get());
  return <div className="kiosk">{paired ? <Station onLost={() => { deviceToken.clear(); setPaired(false); }} /> : <Pairing onPaired={() => setPaired(true)} />}</div>;
}

function Pairing({ onPaired }: { onPaired: () => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try { const r = await post('/kiosk/pair', { pairingCode: code.trim().toUpperCase() }, { noAuth: true }); deviceToken.set(r.deviceToken); kioskHotel.set({ name: r.hotel?.name ?? '', timezone: r.hotel?.timezone ?? 'Europe/Berlin' }); onPaired(); } catch (x) { setErr(x); }
  };
  return (
    <div className="kiosk-card kiosk-center">
      <h1>{t('Tablet einrichten')}</h1>
      <p className="muted">{t('Deine Leitung erzeugt unter „Tablet & Export“ einen Kopplungscode.')}</p>
      <form className="stack" onSubmit={submit}>
        <input className="input kiosk-input" aria-label={t('Kopplungscode')} placeholder="7K4-92M-QX" autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value)} />
        <ErrorBox error={err} />
        <button className="btn btn-primary btn-block" disabled={code.trim().length < 6}>{t('Koppeln')}</button>
      </form>
      <Link className="muted small" to="/login">{t('← Zur Anmeldung')}</Link>
    </div>
  );
}

function useServerClock(serverTime?: string) {
  const [now, setNow] = useState(() => Date.now());
  const offset = useMemo(() => (serverTime ? new Date(serverTime).getTime() - Date.now() : 0), [serverTime]);
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  return new Date(now + offset);
}

function Station({ onLost }: { onLost: () => void }) {
  const { t, lang } = useI18n();
  const hotel = kioskHotel.get();
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [search, setSearch] = useState('');
  const roster = useQuery({
    queryKey: ['kiosk', 'roster', search], refetchInterval: 30_000, retry: false, staleTime: 0, // always fresh: who is clocked in changes with every punch
    queryFn: () => get('/kiosk/roster', search ? { search } : undefined, { device: true }),
  });
  const err = roster.error as ApiError | null;
  useEffect(() => { if (err?.code === 'DEVICE_UNAUTHORIZED') onLost(); }, [err, onLost]);
  const clock = useServerClock(roster.data?.serverTime);
  const qc = useQueryClient();
  const home = useCallback(() => { setStep({ kind: 'list' }); setSearch(''); qc.invalidateQueries({ queryKey: ['kiosk', 'roster'] }); }, [qc]);
  return (
    <div className="kiosk-card">
      <div className="kiosk-head">
        <div className="kiosk-hotel">{hotel.name || t('Stempeluhr')}</div>
        <div className="kiosk-clock" aria-label={t('Serverzeit')}>{new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: hotel.timezone }).format(clock)}</div>
      </div>
      {step.kind === 'list' && (
        <div className="kiosk-body">
          <input className="input kiosk-input" type="search" aria-label={t('Name suchen')} placeholder={t('Name suchen …')} value={search} onChange={(e) => setSearch(e.target.value)} />
          {roster.isLoading && <p className="muted">{t('Lädt …')}</p>}
          <ErrorBox error={err && err.code !== 'DEVICE_UNAUTHORIZED' ? err : null} />
          {!roster.isLoading && (roster.data?.employees ?? []).length === 0 && (
            <p className="muted" role="status">{search ? t('Niemand gefunden.') : t('Gerade ist kein Dienst in Sicht. Tippe deinen Namen, um dich einzustempeln.')}</p>
          )}
          <ul className="plain kiosk-list">
            {(roster.data?.employees ?? []).map((e: any) => (
              <li key={e.id}>
                <button className="kiosk-emp" onClick={() => setStep({ kind: 'pin', emp: e })}>
                  <strong>{e.displayName}</strong>
                  <span className="muted">{e.todayShifts.map((s: any) => `${s.name} ${s.startTime}–${s.endTime}`).join(' · ') || t('kein Dienst geplant')}</span>
                  <span className={`tag ${e.status === 'in' ? 'tag-accent' : 'tag-neutral'}`}>{t(STATUS[e.status] ?? e.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {step.kind === 'pin' && <PinStep emp={step.emp} onBack={home} onVerified={(v) => setStep({ kind: 'action', emp: step.emp, v })} onLost={onLost} />}
      {step.kind === 'action' && <ActionStep emp={step.emp} v={step.v} onBack={home} onDone={(res, action) => setStep({ kind: 'done', res, action })} onExpired={() => setStep({ kind: 'pin', emp: step.emp })} />}
      {step.kind === 'done' && <Done res={step.res} action={step.action} onClose={home} lang={lang} />}
    </div>
  );
}

function PinStep({ emp, onBack, onVerified, onLost }: { emp: any; onBack: () => void; onVerified: (v: any) => void; onLost: () => void }) {
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = useCallback(async (p: string) => {
    setBusy(true); setMsg(null);
    try { onVerified(await post('/kiosk/verify', { employeeId: emp.id, pin: p }, { device: true })); }
    catch (x) {
      const e = x as ApiError;
      if (e.code === 'DEVICE_UNAUTHORIZED') return onLost();
      setPin('');
      if (e.code === 'INVALID_PIN' && e.extra?.attemptsLeft === 0) setMsg(t('PIN gesperrt. Bitte die Leitung fragen.')); // the failed attempt that used up the last try
      else if (e.code === 'INVALID_PIN') setMsg(t('PIN falsch. Noch {n} Versuche.', { n: e.extra?.attemptsLeft ?? '?' }));
      else if (e.code === 'PIN_LOCKED') setMsg(t('PIN gesperrt bis {time}. Bitte die Leitung fragen.', { time: e.extra?.lockedUntil ? fmtTime(e.extra.lockedUntil, kioskHotel.get().timezone) : '…' }));
      else setMsg(e.message);
    } finally { setBusy(false); }
  }, [emp.id, onVerified, onLost, t]);
  const press = (d: string) => { if (busy) return; const next = (pin + d).slice(0, 6); setPin(next); if (next.length === 6) submit(next); };
  return (
    <div className="kiosk-body kiosk-center">
      <h2>{t('Hallo {name}', { name: emp.displayName })}</h2>
      <p className="muted">{t('Bitte PIN eingeben')}</p>
      <div className="pin-dots" aria-label={t('PIN-Eingabe')} role="status">{Array.from({ length: 6 }, (_, i) => <span key={i} className={i < pin.length ? 'dot on' : 'dot'} />)}</div>
      {msg && <div className="error-box" role="alert">{msg}</div>}
      <div className="numpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} className="key" onClick={() => press(d)}>{d}</button>)}
        <button className="key key-sub" onClick={() => setPin('')}>{t('Löschen')}</button>
        <button className="key" onClick={() => press('0')}>0</button>
        <button className="key key-sub" onClick={onBack}>{t('Abbrechen')}</button>
      </div>
    </div>
  );
}

function ActionStep({ emp, v, onBack, onDone, onExpired }: { emp: any; v: any; onBack: () => void; onDone: (res: any, action: string) => void; onExpired: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(55);
  useEffect(() => { const i = setInterval(() => setLeft((l) => l - 1), 1000); return () => clearInterval(i); }, []);
  useEffect(() => { if (left <= 0) onExpired(); }, [left, onExpired]);
  const needsReason = !!v.reasonRequiredForClockIn;
  const punch = async (action: string) => {
    setBusy(true); setErr(null);
    try { onDone(await post('/kiosk/punch', { punchToken: v.punchToken, action, ...(action === 'clock_in' && needsReason ? { reason: reason.trim() } : {}) }, { device: true }), action); }
    catch (x) { if ((x as ApiError).code === 'PUNCH_TOKEN_INVALID') onExpired(); else setErr(x); } finally { setBusy(false); }
  };
  return (
    <div className="kiosk-body kiosk-center">
      <h2>{t('Hallo {name}', { name: v.displayName ?? emp.displayName })}</h2>
      <p className="muted">{t(STATUS[v.status] ?? v.status)} · {v.todayShifts?.map((s: any) => `${s.name} ${s.startTime}–${s.endTime}`).join(' · ') || t('kein Dienst geplant')}</p>
      {needsReason && v.allowedActions.includes('clock_in') && (
        <div className="stack reason">
          <div className="warn">{t('Für dich ist heute kein Dienst geplant. Bitte gib einen Grund an – deine Leitung muss die Zeit freigeben.')}</div>
          <textarea className="input" aria-label={t('Grund')} rows={3} maxLength={500} placeholder={t('z. B. Kollegin krank, Aushilfe …')} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      <ErrorBox error={err} />
      <div className="kiosk-actions">
        {v.allowedActions.length === 0 && <p className="muted">{t('Gerade ist keine Aktion möglich. Bitte die Leitung fragen.')}</p>}
        {v.allowedActions.map((a: string) => (
          <button key={a} className={`btn ${a === 'clock_out' ? 'btn-secondary' : 'btn-primary'} kiosk-big`} disabled={busy || (a === 'clock_in' && needsReason && reason.trim().length < 3)} onClick={() => punch(a)}>{t(ACTION[a] ?? a)}</button>
        ))}
        <button className="btn btn-ghost kiosk-big" onClick={onBack}>{t('Abbrechen')}</button>
      </div>
      <p className="muted small">{t('Die Uhrzeit kommt vom Server. Deine geplante Pause wird automatisch abgezogen.')}</p>
    </div>
  );
}

function Done({ res, action, onClose, lang }: { res: any; action: string; onClose: () => void; lang: string }) {
  const { t } = useI18n();
  const [left, setLeft] = useState(6);
  useEffect(() => { const i = setInterval(() => setLeft((l) => l - 1), 1000); return () => clearInterval(i); }, []);
  useEffect(() => { if (left <= 0) onClose(); }, [left, onClose]);
  const time = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', timeZone: kioskHotel.get().timezone }).format(new Date(res.at));
  return (
    <div className="kiosk-body kiosk-center kiosk-done" role="status">
      <h1>{action === 'clock_in' ? t('Eingestempelt {time}', { time }) : action === 'clock_out' ? t('Ausgestempelt {time}', { time }) : t('{a} {time}', { a: t(ACTION[action] ?? action), time })}</h1>
      <p>{res.displayName}</p>
      {action === 'clock_out' && <p>{t('Heute gearbeitet: {m} Min.', { m: res.workedMinutesToday })}</p>}
      {(res.anomalies ?? []).map((a: any, i: number) => <p key={i} className="warn">{t(ANOMALY[a.type] ?? a.type)}</p>)}
      <button className="btn btn-primary kiosk-big" onClick={onClose}>{t('Fertig')} ({left})</button>
    </div>
  );
}
