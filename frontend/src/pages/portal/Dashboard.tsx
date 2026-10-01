import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { get } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { fmtDate, fmtDays, fmtHours, todayLocal } from '../../lib/format';
import { ErrorBox, Loading, Section, Stat, Tag } from '../../components/ui';

const STATUS: Record<string, string> = { not_in: 'Nicht eingestempelt', in: 'Eingestempelt', on_break: 'In der Pause' };

export default function Dashboard() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['me', 'dashboard'], queryFn: () => get('/me/dashboard'), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const hours = (label: string, x: any) => (
    <Stat label={label} value={`${fmtHours(x.workedHours + x.creditedHours, lang)}`} sub={t('geplant {p} · Soll {s}', { p: fmtHours(x.plannedHours, lang), s: fmtHours(x.targetHours, lang) })} />
  );
  const pending = d.pending ?? {};
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="kicker">{t('Mein Portal')} · {fmtDate(todayLocal(), lang, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <h1>{t('Hallo {name}', { name: user?.firstName ?? '' })}</h1>
        </div>
        <Tag kind={d.today.status === 'in' ? 'accent' : 'neutral'}>{t(STATUS[d.today.status] ?? d.today.status)}</Tag>
      </header>

      <Section title={t('Heute')}>
        {d.today.shifts.length === 0 ? <p className="muted">{t('Heute ist kein Dienst geplant.')}</p> : (
          <ul className="plain">
            {d.today.shifts.map((s: any, i: number) => <li key={i} className="row"><strong>{s.name}</strong><span>{s.startTime}–{s.endTime}</span><span className="muted">{s.hotelName}</span></li>)}
          </ul>
        )}
      </Section>

      <div className="stats">
        {hours(t('Diese Woche'), d.week)}
        {hours(t('Dieser Monat'), d.month)}
        {d.timeAccount?.enabled && <Stat label={t('Arbeitszeitkonto')} value={fmtHours(d.timeAccount.balanceHours, lang)} />}
        <Stat label={t('Urlaub {y}', { y: d.vacation.year })} value={`${fmtDays(d.vacation.remainingDays, lang)} ${t('Tage übrig')}`} sub={t('{n} Tage beantragt', { n: fmtDays(d.vacation.pendingDays, lang) })} />
      </div>

      <Section title={t('Nächste Dienste')}>
        {d.nextShifts.length === 0 ? <p className="muted">{t('Keine weiteren Dienste veröffentlicht.')}</p> : (
          <table className="table">
            <tbody>
              {d.nextShifts.map((s: any, i: number) => (
                <tr key={i}><td>{fmtDate(s.date, lang)}</td><td><strong>{s.shiftName}</strong></td><td>{s.startTime}–{s.endTime}</td><td className="muted">{s.hotelName}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {d.planPublishedUntil?.map((p: any) => <p key={p.hotelId} className="muted small">{p.date ? t('Dienstplan {hotel} veröffentlicht bis {date}', { hotel: p.hotelName, date: fmtDate(p.date, lang, { day: 'numeric', month: 'short' }) }) : t('Dienstplan {hotel}: noch nichts veröffentlicht', { hotel: p.hotelName })}</p>)}
      </Section>

      <Section title={t('Offen')}>
        <div className="row wrap gap">
          <Link className="btn btn-secondary" to="/portal/time-off">{t('Urlaub beantragen')}</Link>
          <Link className="btn btn-secondary" to="/portal/time-off?sick=1">{t('Krank melden')}</Link>
          <Link className="btn btn-secondary" to="/portal/attendance">{t('Stempelzeit korrigieren')}</Link>
          <Link className="btn btn-secondary" to="/portal/inquiries">{t('Frage an die Leitung')}</Link>
        </div>
        <p className="muted small">
          {t('{a} Abwesenheiten · {b} Wünsche · {c} Korrekturen · {d} Fragen offen', { a: pending.timeOffs ?? 0, b: pending.wishes ?? 0, c: pending.corrections ?? 0, d: pending.inquiriesAwaitingAnswer ?? 0 })}
        </p>
      </Section>
    </div>
  );
}
