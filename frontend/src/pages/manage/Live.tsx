import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { get } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { fmtDate, fmtTime, todayLocal } from '../../lib/format';
import { useHotel } from '../../components/hotel';
import { Empty, ErrorBox, Loading, Section, Tag } from '../../components/ui';
import CloseEntryDialog from './CloseEntryDialog';
import { ANOMALY } from '../portal/Attendance';

export default function Live() {
  const { t, lang } = useI18n();
  const { hotel } = useHotel();
  const tz = hotel?.timezone ?? 'Europe/Berlin';
  const q = useQuery({ queryKey: ['live', hotel?.id], enabled: !!hotel, refetchInterval: 15_000, queryFn: () => get('/attendance/live', { hotelId: hotel!.id }) });
  const [fix, setFix] = useState<any>(null);
  const entry = useQuery({ queryKey: ['entry', fix?.timeEntryId], enabled: !!fix, queryFn: () => get(`/attendance/${fix.timeEntryId}`) });
  if (!hotel || q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  return (
    <div className="page">
      <header className="page-head">
        <div><div className="kicker">{hotel.name} · {fmtDate(todayLocal(), lang, { weekday: 'long', day: 'numeric', month: 'long' })}</div><h1>{t('Live-Übersicht')}</h1></div>
        <div className="muted small">{t('Serverzeit')} {fmtTime(d.serverTime, tz, lang)}</div>
      </header>
      <Section title={`${t('Eingestempelt')} (${d.clockedIn.length})`}>
        {d.clockedIn.length === 0 ? <Empty>{t('Gerade niemand eingestempelt.')}</Empty> : (
          <div className="table-scroll"><table className="table"><tbody>
            {d.clockedIn.map((c: any, i: number) => (
              <tr key={i}><td><strong>{c.employee.displayName}</strong></td><td>{c.shift?.name ?? t('ungeplant')}</td><td>{t('seit {t}', { t: fmtTime(c.since, tz, lang) })}</td>
                <td>{c.onBreak && <Tag kind="outline">{t('Pause')}</Tag>}{c.anomalies?.map((a: any, j: number) => <Tag key={j} kind="outline">{t(ANOMALY[a.type] ?? a.type)}</Tag>)}</td></tr>
            ))}
          </tbody></table></div>
        )}
      </Section>
      <Section title={`${t('Erwartet, nicht da')} (${d.expectedNotArrived.length})`}>
        {d.expectedNotArrived.length === 0 ? <Empty>{t('Alle Erwarteten sind da.')}</Empty> : (
          <div className="table-scroll"><table className="table"><tbody>
            {d.expectedNotArrived.map((c: any, i: number) => <tr key={i}><td><strong>{c.employee.displayName}</strong></td><td>{c.shift.name} {c.shift.startTime}</td><td><Tag kind="accent">{t('{n} Min. zu spät', { n: c.minutesLate })}</Tag></td></tr>)}
          </tbody></table></div>
        )}
      </Section>
      {d.noShows.length > 0 && (
        <Section title={`${t('Nicht erschienen')} (${d.noShows.length})`}>
          <div className="table-scroll"><table className="table"><tbody>{d.noShows.map((c: any, i: number) => <tr key={i}><td><strong>{c.employee.displayName}</strong></td><td>{c.shift.name} {c.shift.startTime}–{c.shift.endTime}</td></tr>)}</tbody></table></div>
        </Section>
      )}
      <Section title={`${t('Zu prüfen')} (${d.needsReview.length})`}>
        {d.needsReview.length === 0 ? <Empty>{t('Keine offenen Prüfungen.')}</Empty> : (
          <div className="table-scroll"><table className="table"><tbody>
            {d.needsReview.map((c: any) => (
              <tr key={c.timeEntryId}><td><strong>{c.employee.displayName}</strong></td><td className="muted">{t('Eingestempelt {t}, nie ausgestempelt', { t: new Intl.DateTimeFormat(lang, { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(c.openSince)) })}</td>
                <td><button className="btn btn-primary" onClick={() => setFix(c)}>{t('Mit Korrektur schließen')}</button></td></tr>
            ))}
          </tbody></table></div>
        )}
      </Section>
      {d.awaitingApproval?.length > 0 && (
        <Section title={`${t('Freigabe nötig')} (${d.awaitingApproval.length})`} aside={<Link className="btn btn-secondary" to="/manage/requests">{t('Zu den Anträgen')}</Link>}>
          <p className="muted">{t('Ungeplant gearbeitete Zeiten zählen erst nach deiner Freigabe.')}</p>
        </Section>
      )}
      {fix && entry.data && <CloseEntryDialog entryId={fix.timeEntryId} clockInAt={entry.data.clockInAt} clockOutAt={entry.data.clockOutAt} breakMinutes={entry.data.breakMinutes} tz={tz} onClose={() => setFix(null)} />}
    </div>
  );
}
