import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, getAll, patch, post } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { addDays, fmtDate, fmtMinutes, fmtTime, todayLocal } from '../../lib/format';
import { Dialog, ErrorBox, Field, Loading, Tag } from '../../components/ui';
import { STATUS } from './TimeOff';
import { instantToLocal, localToInstant } from '../../lib/zone';

export const ANOMALY: Record<string, string> = {
  late_clock_in: 'Zu spät eingestempelt', early_clock_in: 'Früh eingestempelt', early_clock_out: 'Früh ausgestempelt', overtime: 'Überstunden',
  unscheduled_work: 'Ungeplant', missing_break: 'Pause fehlt', exceeds_daily_max: 'Tageshöchstzeit', during_time_off: 'Während Abwesenheit',
  auto_closed_planned_hours: 'Automatisch mit Plan-Zeit geschlossen', minor_limit_exceeded: 'Jugendschutz', minor_outside_hours: 'Jugendschutz (Uhrzeit)',
};
export const APPROVAL: Record<string, string> = { pending: 'Wartet auf Freigabe', approved: 'Freigegeben', rejected: 'Abgelehnt' };

const TZ = 'Europe/Berlin';

export default function Attendance() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const from = addDays(todayLocal(), -30);
  const q = useQuery({ queryKey: ['me', 'attendance', from], queryFn: () => getAll<any>('/attendance', { from, to: todayLocal() }) });
  const corrections = useQuery({ queryKey: ['me', 'corrections'], queryFn: () => get('/attendance/corrections').then((r) => r.data) });
  const [target, setTarget] = useState<any>(null);
  const [out, setOut] = useState('');
  const [brk, setBrk] = useState('');
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () => post(`/attendance/${target.id}/corrections`, { proposedClockOutAt: localToInstant(out), ...(brk !== '' ? { proposedBreakMinutes: Number(brk) } : {}), reason }),
    onSuccess: () => { setTarget(null); qc.invalidateQueries({ queryKey: ['me'] }); },
  });
  const withdraw = useMutation({ mutationFn: (id: number) => patch(`/attendance/corrections/${id}`, { status: 'cancelled' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
  const open = (e: any) => { setTarget(e); setOut(e.clockOutAt ? instantToLocal(e.clockOutAt) : `${instantToLocal(e.clockInAt).slice(0, 10)}T`); setBrk(String(e.breakMinutes)); setReason(''); send.reset(); };
  const submit = (e: FormEvent) => { e.preventDefault(); send.mutate(); };
  return (
    <div className="page">
      <header className="page-head"><div><div className="kicker">{t('Letzte 30 Tage')}</div><h1>{t('Meine Zeiten')}</h1></div></header>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (q.data ?? []).length === 0 ? <p className="muted">{t('Keine Einträge.')}</p> : (
        <div className="table-scroll"><table className="table">
          <thead><tr><th>{t('Datum')}</th><th>{t('Von – bis')}</th><th>{t('Pause')}</th><th>{t('Gearbeitet')}</th><th>{t('Status')}</th><th><span className="sr-only">{t('Aktionen')}</span></th></tr></thead>
          <tbody>
            {(q.data ?? []).map((e: any) => (
              <tr key={e.id}>
                <td>{fmtDate(instantToLocal(e.clockInAt).slice(0, 10), lang)}</td>
                <td>{fmtTime(e.clockInAt, TZ, lang)} – {e.clockOutAt ? fmtTime(e.clockOutAt, TZ, lang) : t('offen')}</td>
                <td>{e.breakMinutes} min</td>
                <td>{fmtMinutes(e.workedMinutes)}</td>
                <td className="tags">
                  {e.status === 'needs_review' && <Tag kind="accent">{t('Prüfung')}</Tag>}
                  {e.approvalStatus && e.approvalStatus !== 'not_required' && <Tag kind={e.approvalStatus === 'approved' ? 'neutral' : 'accent'}>{t(APPROVAL[e.approvalStatus])}</Tag>}
                  {e.anomalies.map((a: any, i: number) => <Tag key={i} kind="outline">{t(ANOMALY[a.type] ?? a.type)}</Tag>)}
                </td>
                <td><button className="btn btn-ghost" onClick={() => open(e)}>{t('Korrigieren')}</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {(corrections.data ?? []).length > 0 && (
        <section className="section">
          <div className="section-head"><h2>{t('Meine Korrekturen')}</h2></div>
          <div className="table-scroll"><table className="table"><tbody>
            {corrections.data.map((c: any) => (
              <tr key={c.id}><td>{c.reason}</td><td><Tag kind={c.status === 'pending' ? 'outline' : 'neutral'}>{t(STATUS[c.status] ?? c.status)}</Tag></td>
                <td>{c.status === 'pending' && <button className="btn btn-ghost" onClick={() => withdraw.mutate(c.id)}>{t('Zurückziehen')}</button>}</td></tr>
            ))}
          </tbody></table></div>
        </section>
      )}
      {target && (
        <Dialog title={t('Stempelzeit korrigieren')} onClose={() => setTarget(null)}
          actions={<><button className="btn btn-secondary" onClick={() => setTarget(null)}>{t('Abbrechen')}</button><button className="btn btn-primary" form="corr" disabled={send.isPending || !out || !reason.trim()}>{t('Senden')}</button></>}>
          <form id="corr" className="stack" onSubmit={submit}>
            <Field label={t('Richtige Ausstempelzeit')}>{(i) => <input id={i} className="input" type="datetime-local" required value={out} onChange={(e) => setOut(e.target.value)} />}</Field>
            <Field label={t('Pause (Minuten)')}>{(i) => <input id={i} className="input" type="number" min={0} value={brk} onChange={(e) => setBrk(e.target.value)} />}</Field>
            <Field label={t('Begründung')}>{(i) => <textarea id={i} className="input" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
            <ErrorBox error={send.error} />
          </form>
        </Dialog>
      )}
    </div>
  );
}
