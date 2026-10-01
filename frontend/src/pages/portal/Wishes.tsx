import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, getAll, patch, post } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { addDays, fmtDate, todayLocal } from '../../lib/format';
import { ErrorBox, Field, Loading, Section, Tag } from '../../components/ui';
import { STATUS } from './TimeOff';
import type { Shift } from '../../lib/types';

const PRIORITY: Record<string, string> = { '1': 'niedrig', '2': 'mittel', '3': 'hoch' };

/** Shift/day-off wishes and leave wishes (spec R10): wishes are input for planning, the manager decides. */
export default function Wishes() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ['me', 'profile'], queryFn: () => get('/me/profile') });
  const hotelId = profile.data?.homeHotel?.id as number | undefined;
  const shifts = useQuery({ queryKey: ['wish-shifts', hotelId], enabled: !!hotelId, queryFn: () => getAll<Shift>('/shifts', { hotelId }) });
  const shiftWishes = useQuery({ queryKey: ['me', 'shift-wishes', hotelId], enabled: !!hotelId, queryFn: () => get('/shift-wishes', { hotelId, limit: 50 }).then((r) => r.data as any[]) });
  const leaveWishes = useQuery({ queryKey: ['me', 'leave-wishes', hotelId], enabled: !!hotelId, queryFn: () => get('/leave-wishes', { hotelId, limit: 50 }).then((r) => r.data as any[]) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['me'] });

  const [date, setDate] = useState(addDays(todayLocal(), 14));
  const [kind, setKind] = useState<'avoid' | 'prefer'>('avoid');
  const [shiftId, setShiftId] = useState('');
  const [prio, setPrio] = useState('2');
  const [reason, setReason] = useState('');
  const createShift = useMutation({
    mutationFn: () => post('/employees/me/shift-wishes', { hotelId, date, kind, priority: Number(prio), ...(shiftId ? { shiftId: Number(shiftId) } : {}), ...(reason ? { reason } : {}) }),
    onSuccess: () => { setReason(''); refresh(); },
  });

  const [start, setStart] = useState(addDays(todayLocal(), 30));
  const [end, setEnd] = useState(addDays(todayLocal(), 36));
  const [lPrio, setLPrio] = useState('2');
  const [lReason, setLReason] = useState('');
  const createLeave = useMutation({
    mutationFn: () => post('/employees/me/leave-wishes', { startDate: start, endDate: end, priority: Number(lPrio), ...(lReason ? { reason: lReason } : {}) }),
    onSuccess: () => { setLReason(''); refresh(); },
  });
  const withdraw = useMutation({ mutationFn: (x: { kind: 'shift' | 'leave'; id: number }) => patch(`/${x.kind}-wishes/${x.id}`, { status: 'cancelled' }), onSuccess: refresh });
  const sub = (fn: () => void) => (e: FormEvent) => { e.preventDefault(); fn(); };
  if (profile.isLoading) return <Loading />;
  const prioSelect = (id: string, v: string, set: (x: string) => void) => (
    <select id={id} className="input" value={v} onChange={(e) => set(e.target.value)}>{Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select>
  );
  return (
    <div className="page">
      <header className="page-head"><div><div className="kicker">{t('Planungswünsche')}</div><h1>{t('Wünsche')}</h1></div></header>
      <p className="muted">{t('Wünsche helfen bei der Planung – deine Leitung entscheidet.')}</p>

      <Section title={t('Schicht- oder Freiwunsch')}>
        <form className="stack form-narrow" onSubmit={sub(() => createShift.mutate())}>
          <div className="seg" role="radiogroup" aria-label={t('Art des Wunsches')}>
            {([['avoid', t('Möchte nicht arbeiten')], ['prefer', t('Möchte arbeiten')]] as const).map(([k, l]) => (
              <button type="button" key={k} role="radio" aria-checked={kind === k} className={`seg-btn${kind === k ? ' is-on' : ''}`} onClick={() => setKind(k)}>{l}</button>
            ))}
          </div>
          <div className="row gap wrap">
            <Field label={t('Datum')}>{(i) => <input id={i} className="input" type="date" required min={todayLocal()} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
            <Field label={t('Dienst (optional)')}>{(i) => <select id={i} className="input" value={shiftId} onChange={(e) => setShiftId(e.target.value)}><option value="">{t('ganzer Tag')}</option>{(shifts.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} {s.startTime}–{s.endTime}</option>)}</select>}</Field>
            <Field label={t('Wichtigkeit')}>{(i) => prioSelect(i, prio, setPrio)}</Field>
          </div>
          <Field label={t('Grund (optional)')}>{(i) => <input id={i} className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <ErrorBox error={createShift.error} />
          {createShift.isSuccess && <p className="ok" role="status">{t('Wunsch gesendet.')}</p>}
          <button className="btn btn-primary self-start" disabled={createShift.isPending || !hotelId}>{t('Wunsch senden')}</button>
        </form>
        <WishTable rows={shiftWishes.data} lang={lang} onWithdraw={(id) => withdraw.mutate({ kind: 'shift', id })}
          cols={(w) => [fmtDate(w.date, lang), w.shift ? w.shift.name : t('ganzer Tag'), w.kind === 'avoid' ? t('Frei') : t('Arbeiten')]} />
      </Section>

      <Section title={t('Urlaubswunsch')}>
        <form className="stack form-narrow" onSubmit={sub(() => createLeave.mutate())}>
          <div className="row gap wrap">
            <Field label={t('Von')}>{(i) => <input id={i} className="input" type="date" required min={todayLocal()} value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} />}</Field>
            <Field label={t('Bis')}>{(i) => <input id={i} className="input" type="date" required min={start} value={end} onChange={(e) => setEnd(e.target.value)} />}</Field>
            <Field label={t('Wichtigkeit')}>{(i) => prioSelect(i, lPrio, setLPrio)}</Field>
          </div>
          <Field label={t('Grund (optional)')}>{(i) => <input id={i} className="input" maxLength={500} value={lReason} onChange={(e) => setLReason(e.target.value)} />}</Field>
          <ErrorBox error={createLeave.error} />
          {createLeave.isSuccess && <p className="ok" role="status">{t('Wunsch gesendet.')}</p>}
          <button className="btn btn-primary self-start" disabled={createLeave.isPending}>{t('Wunsch senden')}</button>
        </form>
        <WishTable rows={leaveWishes.data} lang={lang} onWithdraw={(id) => withdraw.mutate({ kind: 'leave', id })}
          cols={(w) => [`${fmtDate(w.startDate, lang, { day: 'numeric', month: 'short' })} – ${fmtDate(w.endDate, lang, { day: 'numeric', month: 'short' })}`, `${w.leaveDays ?? ''} ${t('Tage')}`]} />
      </Section>
    </div>
  );
}

function WishTable({ rows, cols, onWithdraw, lang }: { rows?: any[]; cols: (w: any) => string[]; onWithdraw: (id: number) => void; lang: string }) {
  const { t } = useI18n();
  void lang;
  if (!rows?.length) return <p className="muted">{t('Noch keine Wünsche.')}</p>;
  return (
    <table className="table"><tbody>
      {rows.map((w) => (
        <tr key={w.id}>
          {cols(w).map((c, i) => <td key={i}>{c}</td>)}
          <td className="muted small">{w.reason}</td>
          <td><Tag kind={w.status === 'approved' ? 'accent' : 'outline'}>{t(STATUS[w.status] ?? w.status)}</Tag></td>
          <td>{w.status === 'pending' && <button className="btn btn-ghost" onClick={() => onWithdraw(w.id)}>{t('Zurückziehen')}</button>}</td>
        </tr>
      ))}
    </tbody></table>
  );
}
