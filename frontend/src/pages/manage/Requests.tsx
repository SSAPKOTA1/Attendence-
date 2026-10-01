import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, getAll, patch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { addDays, fmtDate, fmtDays, fmtMinutes, fmtTime, todayLocal, windows } from '../../lib/format';
import { useHotel } from '../../components/hotel';
import { useHotelEmployees } from '../../components/employees';
import { Dialog, Empty, ErrorBox, Field, Loading, Section, Tag } from '../../components/ui';
import { TYPES } from '../portal/TimeOff';

type Decision = { kind: 'timeoff' | 'correction' | 'approval' | 'shift-wish' | 'leave-wish'; id: number; status: 'approved' | 'rejected'; label: string };

export default function Requests() {
  const { t, lang } = useI18n();
  const { hotel } = useHotel();
  const hid = hotel?.id;
  const tz = hotel?.timezone ?? 'Europe/Berlin';
  const qc = useQueryClient();
  const { nameOf } = useHotelEmployees(hid);
  const today = todayLocal();
  const timeoffs = useQuery({
    queryKey: ['req', 'timeoffs', hid], enabled: !!hid,
    queryFn: async () => {
      const parts = await Promise.all(windows(today, 4).map((w) => get('/time-offs', { hotelId: hid, status: 'pending', ...w }).then((r) => r.data as any[])));
      return [...new Map(parts.flat().filter((x) => x.id && x.status === 'pending').map((x) => [x.id, x])).values()];
    },
  });
  const corrections = useQuery({ queryKey: ['req', 'corr', hid], enabled: !!hid, queryFn: () => get('/attendance/corrections', { hotelId: hid, status: 'pending' }).then((r) => r.data as any[]) });
  const approvals = useQuery({ queryKey: ['req', 'appr', hid], enabled: !!hid, queryFn: () => getAll<any>('/attendance', { hotelId: hid, from: addDays(today, -61), to: today, approvalStatus: 'pending' }) });
  const wishes = useQuery({ queryKey: ['req', 'wishes', hid], enabled: !!hid, queryFn: () => get(`/hotels/${hid}/planning-dashboard`, { from: today, to: addDays(today, 61) }) });
  const [dec, setDec] = useState<Decision | null>(null);
  const [note, setNote] = useState('');
  const [unassign, setUnassign] = useState(true);

  const decide = useMutation({
    mutationFn: (d: Decision) => {
      if (d.kind === 'timeoff') return patch(`/time-offs/${d.id}`, { status: d.status, ...(d.status === 'approved' ? { unassignConflicts: unassign } : {}) });
      if (d.kind === 'correction') return patch(`/attendance/corrections/${d.id}`, { status: d.status, ...(note ? { decisionNote: note } : {}) });
      if (d.kind === 'approval') return patch(`/attendance/${d.id}/approval`, { status: d.status, ...(note ? { note } : {}) });
      return patch(`/${d.kind === 'shift-wish' ? 'shift-wishes' : 'leave-wishes'}/${d.id}`, { status: d.status, ...(note ? { decisionNote: note } : {}) });
    },
    onSuccess: () => { setDec(null); setNote(''); qc.invalidateQueries(); },
  });
  const ask = (d: Decision) => { decide.reset(); setNote(''); setDec(d); };
  const buttons = (kind: Decision['kind'], id: number, label: string) => (
    <div className="row gap">
      <button className="btn btn-primary" onClick={() => ask({ kind, id, status: 'approved', label })}>{kind === 'approval' ? t('Freigeben') : t('Genehmigen')}</button>
      <button className="btn btn-secondary" onClick={() => ask({ kind, id, status: 'rejected', label })}>{t('Ablehnen')}</button>
    </div>
  );
  if (!hotel) return <Loading />;
  // the planning dashboard also lists decided wishes; only pending ones are requests
  const sw = (wishes.data?.shiftWishes ?? []).filter((w: any) => w.status === 'pending');
  const lw = (wishes.data?.leaveWishes ?? []).filter((w: any) => w.status === 'pending');
  const total = (timeoffs.data?.length ?? 0) + (corrections.data?.length ?? 0) + (approvals.data?.length ?? 0) + sw.length + lw.length;
  return (
    <div className="page">
      <header className="page-head"><div><div className="kicker">{hotel.name}</div><h1>{t('Anträge')}</h1></div><Tag kind={total ? 'accent' : 'neutral'}>{t('{n} offen', { n: total })}</Tag></header>

      <Section title={`${t('Ungeplante Arbeitszeit')} (${approvals.data?.length ?? 0})`}>
        {!approvals.data?.length ? <Empty>{t('Nichts zur Freigabe.')}</Empty> : (
          <div className="table-scroll"><table className="table"><tbody>
            {approvals.data.map((e: any) => (
              <tr key={e.id}>
                <td><strong>{e.employee?.displayName ?? nameOf(e.employeeId)}</strong></td>
                <td>{fmtTime(e.clockInAt, tz, lang)}–{e.clockOutAt ? fmtTime(e.clockOutAt, tz, lang) : '…'} · {fmtMinutes(e.status === 'closed' ? e.workedMinutes ?? null : null)}</td>
                <td className="small">{e.unplannedReason}{e.status !== 'closed' && <div className="muted">{t('noch nicht ausgestempelt')}</div>}</td>
                <td>{e.status === 'closed' ? buttons('approval', e.id, nameOf(e.employeeId)) : <Tag kind="outline">{t('läuft noch')}</Tag>}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </Section>

      <Section title={`${t('Abwesenheiten')} (${timeoffs.data?.length ?? 0})`}>
        {timeoffs.isLoading ? <Loading /> : !timeoffs.data?.length ? <Empty>{t('Keine offenen Abwesenheiten.')}</Empty> : (
          <div className="table-scroll"><table className="table"><tbody>
            {timeoffs.data.map((x: any) => (
              <tr key={x.id}>
                <td><strong>{nameOf(x.employeeId)}</strong></td><td>{t(TYPES[x.type] ?? x.type)}</td>
                <td>{fmtDate(x.startDate, lang, { day: 'numeric', month: 'short' })} – {fmtDate(x.endDate, lang, { day: 'numeric', month: 'short' })} · {fmtDays(x.timeOffDays, lang)} {t('Tage')}</td>
                <td className="muted small">{x.reason}</td><td>{buttons('timeoff', x.id, nameOf(x.employeeId))}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </Section>

      <Section title={`${t('Stempelkorrekturen')} (${corrections.data?.length ?? 0})`}>
        {!corrections.data?.length ? <Empty>{t('Keine offenen Korrekturen.')}</Empty> : (
          <div className="table-scroll"><table className="table"><tbody>
            {corrections.data.map((c: any) => (
              <tr key={c.id}>
                <td><strong>{nameOf(c.employeeId)}</strong></td>
                <td>{c.proposedClockOutAt ? t('Ausstempeln {t}', { t: fmtTime(c.proposedClockOutAt, tz, lang) }) : t('Änderung')}{c.proposedBreakMinutes != null ? ` · ${c.proposedBreakMinutes} min` : ''}</td>
                <td className="muted small">{c.reason}</td><td>{buttons('correction', c.id, nameOf(c.employeeId))}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </Section>

      <Section title={`${t('Wünsche')} (${sw.length + lw.length})`}>
        {sw.length + lw.length === 0 ? <Empty>{t('Keine offenen Wünsche.')}</Empty> : (
          <div className="table-scroll"><table className="table"><tbody>
            {sw.map((w: any) => (
              <tr key={`s${w.id}`}>
                <td><strong>{w.employee?.displayName ?? w.employee?.name}</strong></td><td>{w.kind === 'avoid' && !w.shift ? t('Freiwunsch') : t('Schichtwunsch')}</td>
                <td>{fmtDate(w.date, lang)}{w.shift ? ` · ${w.shift.name}` : ''}</td><td className="muted small">{w.reason}</td><td>{buttons('shift-wish', w.id, '')}</td>
              </tr>
            ))}
            {lw.map((w: any) => (
              <tr key={`l${w.id}`}>
                <td><strong>{w.employee?.displayName ?? w.employee?.name}</strong></td><td>{t('Urlaubswunsch')}</td>
                <td>{fmtDate(w.startDate, lang, { day: 'numeric', month: 'short' })} – {fmtDate(w.endDate, lang, { day: 'numeric', month: 'short' })}
                  {w.coverageRisk?.understaffedDates?.length > 0 && <div className="warn small">{t('Unterbesetzt am {d}, falls genehmigt', { d: w.coverageRisk.understaffedDates.map((d: string) => fmtDate(d, lang, { day: 'numeric', month: 'short' })).join(', ') })}</div>}</td>
                <td className="muted small">{w.reason}</td><td>{buttons('leave-wish', w.id, '')}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </Section>

      {dec && (
        <Dialog title={dec.status === 'approved' ? t('Genehmigen?') : t('Ablehnen?')} onClose={() => setDec(null)}
          actions={<><button className="btn btn-secondary" onClick={() => setDec(null)}>{t('Abbrechen')}</button>
            <button className="btn btn-primary" disabled={decide.isPending || (dec.status === 'rejected' && (dec.kind === 'approval') && !note.trim())} onClick={() => decide.mutate(dec)}>{dec.status === 'approved' ? t('Bestätigen') : t('Ablehnen')}</button></>}>
          <div className="stack">
            {dec.label && <strong>{dec.label}</strong>}
            {dec.kind === 'timeoff' && dec.status === 'approved' && <label className="check"><input type="checkbox" checked={unassign} onChange={(e) => setUnassign(e.target.checked)} /> {t('Geplante Dienste an diesen Tagen entfernen')}</label>}
            {dec.kind !== 'timeoff' && <Field label={dec.status === 'rejected' && dec.kind === 'approval' ? t('Begründung (nötig)') : t('Notiz (optional)')}>{(i) => <textarea id={i} className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>}
            <ErrorBox error={decide.error} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
