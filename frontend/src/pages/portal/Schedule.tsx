import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { addDays, fmtDate, isoWeek, todayLocal, weekDays, weekStart } from '../../lib/format';
import { ErrorBox, Loading, Tag } from '../../components/ui';

export default function Schedule() {
  const { t, lang } = useI18n();
  const [start, setStart] = useState(() => weekStart(todayLocal()));
  const days = weekDays(start);
  const mine = useQuery({ queryKey: ['me', 'schedule', start], queryFn: () => get('/schedules', { employeeId: 'me', from: days[0], to: days[6] }).then((r) => r.data) });
  // staff who work at several hotels must say which hotel's plan they want to see (the API requires hotelId then)
  const profile = useQuery({ queryKey: ['me', 'profile'], queryFn: () => get('/me/profile') });
  const hotels: { id: number; name: string }[] = profile.data?.hotels ?? [];
  const [hotelPick, setHotelPick] = useState<number | null>(null);
  const hotelId = hotelPick ?? profile.data?.homeHotel?.id;
  const team = useQuery({ queryKey: ['team', 'schedule', start, hotelId], enabled: !!profile.data, queryFn: () => get('/schedules', { from: days[0], to: days[6], hotelId: hotels.length > 1 ? hotelId : undefined }).then((r) => r.data), retry: false });
  const [showTeam, setShowTeam] = useState(false);
  return (
    <div className="page">
      <header className="page-head">
        <div><div className="kicker">{t('Woche {n}', { n: isoWeek(start) })}</div><h1>{t('Mein Dienstplan')}</h1></div>
        <div className="row gap">
          <button className="btn btn-secondary btn-icon" aria-label={t('Vorherige Woche')} onClick={() => setStart(addDays(start, -7))}>‹</button>
          <button className="btn btn-secondary" onClick={() => setStart(weekStart(todayLocal()))}>{t('Heute')}</button>
          <button className="btn btn-secondary btn-icon" aria-label={t('Nächste Woche')} onClick={() => setStart(addDays(start, 7))}>›</button>
        </div>
      </header>
      {mine.isLoading ? <Loading /> : mine.error ? <ErrorBox error={mine.error} /> : (
        <ul className="plain days">
          {days.map((d) => {
            const entries = (mine.data ?? []).filter((e: any) => e.date === d);
            return (
              <li key={d} className={`day ${d === todayLocal() ? 'is-today' : ''}`}>
                <div className="day-name">{fmtDate(d, lang)}</div>
                <div className="day-body">
                  {entries.length === 0 && <span className="muted">–</span>}
                  {entries.map((e: any) => e.entryType === 'off'
                    ? <Tag key={e.id} kind="outline">{e.offLabel ?? t('Frei')}</Tag>
                    : <div key={e.id} className="shiftchip"><strong>{e.shift.name}</strong> {e.shift.startTime}–{e.shift.endTime}{e.hotelName ? <span className="muted"> · {e.hotelName}</span> : null}</div>)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!team.error && (
        <>
          <div className="row gap wrap">
            <button className="btn btn-ghost" onClick={() => setShowTeam(!showTeam)} aria-expanded={showTeam}>{showTeam ? t('Kolleg:innen ausblenden') : t('Wer arbeitet noch?')}</button>
            {showTeam && hotels.length > 1 && (
              <select className="input compact" aria-label={t('Hotel wählen')} value={hotelId ?? ''} onChange={(e) => setHotelPick(Number(e.target.value))}>
                {hotels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            )}
          </div>
          {showTeam && (team.data ?? []).length === 0 && <p className="muted">{t('Keine Einträge sichtbar.')}</p>}
          {showTeam && (
            <div className="table-scroll"><table className="table">
              <tbody>
                {(team.data ?? []).filter((e: any) => !e.isMine).map((e: any, i: number) => (
                  <tr key={i}><td>{fmtDate(e.date, lang)}</td><td>{e.employee?.displayName}</td><td>{e.shift?.name} {e.shift?.startTime}–{e.shift?.endTime}</td><td className="muted">{e.department?.name}</td></tr>
                ))}
              </tbody>
            </table></div>
          )}
        </>
      )}
    </div>
  );
}
