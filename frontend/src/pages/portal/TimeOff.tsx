import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { del, get, post } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { fmtDate, fmtDays, todayLocal } from '../../lib/format';
import { ErrorBox, Field, Loading, Section, Stat, Tag, Warnings } from '../../components/ui';

export const TYPES: Record<string, string> = { annual_leave: 'Urlaub', sick_leave: 'Krank', unpaid_leave: 'Unbezahlt', school: 'Berufsschule', other: 'Sonstiges' };
const STATUS_KIND: Record<string, 'accent' | 'neutral' | 'outline'> = { pending: 'outline', approved: 'accent', rejected: 'neutral', cancelled: 'neutral' };
export const STATUS: Record<string, string> = { pending: 'Offen', approved: 'Genehmigt', rejected: 'Abgelehnt', cancelled: 'Zurückgezogen' };

export default function TimeOff() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const year = Number(todayLocal().slice(0, 4));
  const allowance = useQuery({ queryKey: ['me', 'allowance', year], queryFn: () => get('/employees/me/vacation-allowance', { year }) });
  // the API defaults to the current calendar year; requests are often made for next year
  const list = useQuery({ queryKey: ['me', 'timeoffs', year], queryFn: () => get('/employees/me/time-offs', { from: `${year}-01-01`, to: `${year + 1}-12-31` }).then((r) => r.data) });

  const [type, setType] = useState(params.get('sick') ? 'sick_leave' : 'annual_leave');
  const [start, setStart] = useState(todayLocal());
  const [end, setEnd] = useState(todayLocal());
  const [halfStart, setHalfStart] = useState(false);
  const [halfEnd, setHalfEnd] = useState(false);
  const [reason, setReason] = useState('');
  const body = { employeeId: 'me', type, startDate: start, endDate: end, startHalfDay: halfStart, endHalfDay: halfEnd };
  const preview = useMutation({ mutationFn: () => post('/time-offs/preview', body) });
  const create = useMutation({
    mutationFn: () => post('/employees/me/time-offs', { type, startDate: start, endDate: end, startHalfDay: halfStart, endHalfDay: halfEnd, ...(type !== 'sick_leave' && reason ? { reason } : {}) }),
    onSuccess: () => { preview.reset(); setReason(''); qc.invalidateQueries({ queryKey: ['me'] }); },
  });
  const cancel = useMutation({ mutationFn: (id: number) => del(`/time-offs/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  const a = allowance.data;
  const p = preview.data;
  return (
    <div className="page">
      <header className="page-head"><div><div className="kicker">{t('Urlaub {y}', { y: year })}</div><h1>{t('Urlaub & Abwesenheit')}</h1></div></header>
      {a && (
        <div className="stats">
          <Stat label={t('Übrig')} value={`${fmtDays(a.remainingDays, lang)} ${t('Tage')}`} sub={t('von {n} Tagen im Jahr', { n: fmtDays(a.vacationDaysPerYear, lang) })} />
          <Stat label={t('Übertrag aus Vorjahr')} value={fmtDays(a.carriedOverDays, lang)} sub={a.carryOverExpiresOn ? t('verfällt am {d}', { d: fmtDate(a.carryOverExpiresOn, lang, { day: 'numeric', month: 'short' }) }) : undefined} />
          <Stat label={t('Genommen')} value={fmtDays(a.usedDays, lang)} />
          <Stat label={t('Beantragt')} value={fmtDays(a.pendingDays, lang)} />
        </div>
      )}
      <Section title={t('Neuer Antrag')}>
        <form className="stack form-narrow" onSubmit={submit}>
          <Field label={t('Art')}>{(i) => (
            <select id={i} className="input" value={type} onChange={(e) => { setType(e.target.value); preview.reset(); }}>
              {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
            </select>
          )}</Field>
          <div className="row gap wrap">
            <Field label={t('Von')}>{(i) => <input id={i} className="input" type="date" required value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); preview.reset(); }} />}</Field>
            <Field label={t('Bis')}>{(i) => <input id={i} className="input" type="date" required min={start} value={end} onChange={(e) => { setEnd(e.target.value); preview.reset(); }} />}</Field>
          </div>
          <div className="row gap wrap">
            <label className="check"><input type="checkbox" checked={halfStart} onChange={(e) => { setHalfStart(e.target.checked); preview.reset(); }} /> {t('Erster Tag halbtags')}</label>
            <label className="check"><input type="checkbox" checked={halfEnd} onChange={(e) => { setHalfEnd(e.target.checked); preview.reset(); }} /> {t('Letzter Tag halbtags')}</label>
          </div>
          {type !== 'sick_leave' && <Field label={t('Grund (optional)')}>{(i) => <input id={i} className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
          {type === 'sick_leave' && <p className="muted small">{t('Bitte keine Diagnose angeben. Ab dem 4. Tag brauchst du eine Krankschreibung.')}</p>}
          <div className="row gap">
            <button type="button" className="btn btn-secondary" onClick={() => preview.mutate()} disabled={preview.isPending}>{t('Prüfen')}</button>
            <button className="btn btn-primary" disabled={create.isPending}>{type === 'sick_leave' ? t('Krank melden') : t('Beantragen')}</button>
          </div>
          <ErrorBox error={preview.error ?? create.error} />
          {create.isSuccess && <p role="status" className="ok">{t('Antrag gesendet.')}</p>}
          {p && (
            <div className="preview" aria-live="polite">
              <strong>{t('{n} Tage', { n: fmtDays(p.timeOffDays, lang) })}</strong>
              {p.allowance && type === 'annual_leave' && <span> · {t('Resturlaub {a} → {b}', { a: fmtDays(p.allowance.remainingBefore, lang), b: fmtDays(p.allowance.remainingAfter, lang) })}</span>}
              {p.skipped?.length > 0 && <div className="muted small">{t('Übersprungen: {x}', { x: p.skipped.map((s: any) => `${fmtDate(s.date, lang, { day: 'numeric', month: 'short' })}${s.name ? ` (${s.name})` : ''}`).join(', ') })}</div>}
              {p.conflicts?.scheduleIds?.length > 0 && <div className="warn">{t('{n} geplante Dienste an diesen Tagen.', { n: p.conflicts.scheduleIds.length })}</div>}
              <Warnings items={p.warnings} />
            </div>
          )}
        </form>
      </Section>
      <Section title={t('Meine Anträge')}>
        {list.isLoading ? <Loading /> : (list.data ?? []).length === 0 ? <p className="muted">{t('Noch keine Anträge.')}</p> : (
          <div className="table-scroll"><table className="table">
            <tbody>
              {(list.data ?? []).map((x: any) => (
                <tr key={x.id}>
                  <td>{t(TYPES[x.type] ?? x.type)}</td>
                  <td>{fmtDate(x.startDate, lang, { day: 'numeric', month: 'short', year: 'numeric' })} – {fmtDate(x.endDate, lang, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                  <td>{fmtDays(x.timeOffDays, lang)} {t('Tage')}</td>
                  <td><Tag kind={STATUS_KIND[x.status]}>{t(STATUS[x.status] ?? x.status)}</Tag></td>
                  <td>{x.status === 'pending' && <button className="btn btn-ghost" onClick={() => cancel.mutate(x.id)}>{t('Zurückziehen')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Section>
    </div>
  );
}
