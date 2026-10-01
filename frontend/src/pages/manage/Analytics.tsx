import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { fmtHours, todayLocal } from '../../lib/format';
import { useHotel } from '../../components/hotel';
import { ErrorBox, Field, Loading, Section, Stat, Tag } from '../../components/ui';

const HOURS_STATUS: Record<string, string> = { below: 'unter Soll', on_target: 'im Soll', above: 'über Soll', over_max: 'über Maximum' };
const monthEnd = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };

export default function Analytics() {
  const { t, lang } = useI18n();
  const { hotel } = useHotel();
  const [month, setMonth] = useState(todayLocal().slice(0, 7));
  const from = `${month}-01`;
  const to = monthEnd(month);
  const hid = hotel?.id;
  const hours = useQuery({ queryKey: ['an', 'hours', hid, month], enabled: !!hid, queryFn: () => get(`/hotels/${hid}/analytics/hours`, { month }) });
  const abs = useQuery({ queryKey: ['an', 'abs', hid, month], enabled: !!hid, queryFn: () => get(`/hotels/${hid}/analytics/absences`, { from, to }) });
  const att = useQuery({ queryKey: ['an', 'att', hid, month], enabled: !!hid, queryFn: () => get(`/hotels/${hid}/analytics/attendance`, { from, to }) });
  const overview = useQuery({ queryKey: ['an', 'overview', month], queryFn: () => get('/analytics/overview', { from, to }) });
  if (!hotel) return <Loading />;
  const tt = att.data?.totals;
  return (
    <div className="page">
      <header className="page-head"><div><div className="kicker">{hotel.name}</div><h1>{t('Auswertung')}</h1></div>
        <Field label={t('Monat')}>{(i) => <input id={i} className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />}</Field></header>

      {(overview.data?.hotels?.length ?? 0) > 1 && (
        <Section title={t('Alle Hotels')}>
          <div className="table-scroll"><table className="table"><thead><tr><th>{t('Hotel')}</th><th>{t('Personen')}</th><th>{t('Geplant')}</th><th>{t('Gearbeitet')}</th><th>{t('Krankenquote')}</th><th>{t('Offen')}</th></tr></thead><tbody>
            {overview.data.hotels.map((h: any) => <tr key={h.hotelId}><td><strong>{h.name}</strong></td><td>{h.headcount}</td><td>{fmtHours(h.scheduledPaidHours, lang)}</td><td>{fmtHours(h.actualPaidHours, lang)}</td><td>{(h.sickRate * 100).toFixed(1)} %</td><td>{h.openCorrections + h.needsReviewEntries}</td></tr>)}
          </tbody></table></div>
        </Section>
      )}

      <Section title={t('Anwesenheit')}>
        {att.error ? <ErrorBox error={att.error} /> : tt && (
          <div className="stats">
            <Stat label={t('Geplant')} value={fmtHours(tt.plannedPaidHours, lang)} />
            <Stat label={t('Gearbeitet')} value={fmtHours(tt.actualPaidHours, lang)} />
            <Stat label={t('Verspätungen')} value={tt.lateCount} />
            <Stat label={t('Nicht erschienen')} value={tt.noShowCount} tone={tt.noShowCount ? 'warn' : undefined} />
            <Stat label={t('Überstunden')} value={fmtHours(tt.overtimeHours, lang)} />
            <Stat label={t('Freigabe offen')} value={tt.entriesAwaitingApproval} tone={tt.entriesAwaitingApproval ? 'warn' : undefined} />
          </div>
        )}
      </Section>

      <Section title={t('Stunden vs. Soll')}>
        {hours.isLoading ? <Loading /> : hours.error ? <ErrorBox error={hours.error} /> : (
          <div className="table-scroll"><table className="table"><thead><tr><th>{t('Name')}</th><th>{t('Geplant')}</th><th>{t('Gutschrift')}</th><th>{t('Soll')}</th><th>{t('Differenz')}</th><th><span className="sr-only">{t('Aktionen')}</span></th></tr></thead><tbody>
            {hours.data.byEmployee.map((e: any) => <tr key={e.employeeId}><td><strong>{e.name}</strong>{!e.isHome && <> <Tag kind="outline">{t('Springer')}</Tag></>}</td><td>{fmtHours(e.scheduledPaidHours, lang)}</td><td>{fmtHours(e.creditedHours, lang)}</td><td>{fmtHours(e.targetHours, lang)}</td><td>{fmtHours(e.delta, lang)}</td><td><Tag kind={e.status === 'over_max' ? 'accent' : 'neutral'}>{t(HOURS_STATUS[e.status] ?? e.status)}</Tag></td></tr>)}
          </tbody></table></div>
        )}
      </Section>

      <Section title={t('Krankenstand')}>
        {abs.isLoading ? <Loading /> : abs.error ? <ErrorBox error={abs.error} /> : (
          <>
            <div className="stats">
              <Stat label={t('Krankheitstage')} value={abs.data.totals.sickDays} />
              <Stat label={t('Fälle')} value={abs.data.totals.spells} />
              <Stat label={t('Betroffene')} value={abs.data.totals.employeesAffected} />
              <Stat label={t('Quote')} value={`${(abs.data.totals.absenceRate * 100).toFixed(1)} %`} />
            </div>
            <div className="table-scroll"><table className="table"><thead><tr><th>{t('Name')}</th><th>{t('Tage')}</th><th>{t('Fälle')}</th><th>{t('Bradford')}</th><th>{t('Atteste fehlen')}</th></tr></thead><tbody>
              {abs.data.byEmployee.filter((e: any) => e.sickDays > 0).map((e: any) => <tr key={e.employeeId}><td><strong>{e.name}</strong></td><td>{e.sickDays}</td><td>{e.spells}</td><td>{e.bradfordFactor}</td><td>{e.missingCertificates || '–'}</td></tr>)}
            </tbody></table></div>
          </>
        )}
      </Section>
    </div>
  );
}
