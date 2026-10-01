import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, download, get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { todayLocal } from '../../lib/format';
import { useHotel } from '../../components/hotel';
import { Dialog, Empty, ErrorBox, Field, Loading, Section, Tag } from '../../components/ui';

export default function Devices() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const { hotel } = useHotel();
  const qc = useQueryClient();
  const hid = hotel?.id;
  const devices = useQuery({ queryKey: ['devices', hid], enabled: !!hid, queryFn: () => get('/kiosk/devices', { hotelId: hid }).then((r) => r.data as any[]) });
  const [deviceName, setDeviceName] = useState('');
  const [code, setCode] = useState<{ pairingCode: string; expiresAt: string } | null>(null);
  const pair = useMutation({ mutationFn: () => post('/kiosk/pairing-codes', { hotelId: hid, deviceName: deviceName || t('Tablet') }), onSuccess: (r) => { setCode(r); setDeviceName(''); } });
  const revoke = useMutation({ mutationFn: (id: number) => del(`/kiosk/devices/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }) });

  const [lockDate, setLockDate] = useState('');
  const [lockReason, setLockReason] = useState('');
  const lock = useMutation({ mutationFn: () => put(`/hotels/${hid}/attendance-lock`, { lockedUntil: lockDate, ...(lockReason ? { reason: lockReason } : {}) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['hotels'] }) });

  const [month, setMonth] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); });
  const [format, setFormat] = useState('csv');
  const exp = useMutation({
    mutationFn: async () => {
      const ext = format === 'json' ? 'json' : format === 'datev' ? 'txt' : 'csv';
      await download(`/hotels/${hid}/payroll-export`, { month, format }, `payroll-${month}.${ext}`);
    },
  });
  const warnings = useQuery({ queryKey: ['export-warnings', hid, month], enabled: !!hid, queryFn: () => get(`/hotels/${hid}/payroll-export`, { month, format: 'json' }).then((r) => r.warnings as string[]) });
  if (!hotel) return <Loading />;
  const WARN: Record<string, string> = { period_not_locked: 'Der Zeitraum ist noch nicht gesperrt.', entries_pending_approval: 'Es gibt noch Zeiten, die auf Freigabe warten.' };
  return (
    <div className="page">
      <header className="page-head"><div><div className="kicker">{hotel.name}</div><h1>{t('Tablet & Export')}</h1></div></header>

      <Section title={t('Stempel-Tablets')}>
        <div className="row gap wrap">
          <Field label={t('Name des Tablets')}>{(i) => <input id={i} className="input" value={deviceName} placeholder={t('Rezeption')} onChange={(e) => setDeviceName(e.target.value)} />}</Field>
          <button className="btn btn-primary self-end" onClick={() => pair.mutate()} disabled={pair.isPending}>{t('Kopplungscode erzeugen')}</button>
        </div>
        <ErrorBox error={pair.error} />
        {!devices.data?.length ? <Empty>{t('Noch kein Tablet gekoppelt.')}</Empty> : (
          <table className="table"><tbody>
            {devices.data.map((d: any) => (
              <tr key={d.id}><td><strong>{d.name}</strong></td><td className="muted">{d.lastSeenAt ? new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(d.lastSeenAt)) : t('noch nie benutzt')}</td>
                <td>{d.status === 'active' ? <button className="btn btn-ghost" onClick={() => revoke.mutate(d.id)}>{t('Entkoppeln')}</button> : <Tag kind="neutral">{t('entkoppelt')}</Tag>}</td></tr>
            ))}
          </tbody></table>
        )}
        <p className="muted small">{t('Auf dem Tablet {url} öffnen und den Code eingeben.', { url: `${window.location.origin}/kiosk` })}</p>
      </Section>

      <Section title={t('Zeitraum sperren')}>
        <p className="muted small">{hotel.attendanceLockedUntil ? t('Gesperrt bis {d}.', { d: hotel.attendanceLockedUntil }) : t('Noch nichts gesperrt.')} {user?.role !== 'admin' && t('Die Sperre kann nur nach vorne verschoben werden.')}</p>
        <div className="row gap wrap">
          <Field label={t('Gesperrt bis einschließlich')}>{(i) => <input id={i} className="input" type="date" max={todayLocal()} value={lockDate} onChange={(e) => setLockDate(e.target.value)} />}</Field>
          {user?.role === 'admin' && <Field label={t('Begründung (falls nötig)')}>{(i) => <input id={i} className="input" value={lockReason} onChange={(e) => setLockReason(e.target.value)} />}</Field>}
          <button className="btn btn-secondary self-end" disabled={!lockDate || lock.isPending} onClick={() => lock.mutate()}>{t('Sperren')}</button>
        </div>
        <ErrorBox error={lock.error} />
        {lock.isSuccess && <p className="ok" role="status">{t('Gespeichert.')}</p>}
      </Section>

      <Section title={t('Lohn-Export')}>
        <div className="row gap wrap">
          <Field label={t('Monat')}>{(i) => <input id={i} className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />}</Field>
          <Field label={t('Format')}>{(i) => <select id={i} className="input" value={format} onChange={(e) => setFormat(e.target.value)}><option value="csv">CSV</option><option value="json">JSON</option><option value="datev">DATEV LODAS</option></select>}</Field>
          <button className="btn btn-primary self-end" disabled={exp.isPending} onClick={() => exp.mutate()}>{t('Herunterladen')}</button>
        </div>
        {(warnings.data ?? []).map((w) => <p key={w} className="warn">{t(WARN[w] ?? w)}</p>)}
        <ErrorBox error={exp.error} />
      </Section>

      {code && (
        <Dialog title={t('Kopplungscode')} onClose={() => setCode(null)} actions={<button className="btn btn-primary" onClick={() => { setCode(null); qc.invalidateQueries({ queryKey: ['devices'] }); }}>{t('Fertig')}</button>}>
          <p className="pin-show" aria-label={t('Kopplungscode')}>{code.pairingCode}</p>
          <p className="muted small">{t('Gültig bis {t}. Auf dem Tablet unter /kiosk eingeben.', { t: new Intl.DateTimeFormat(lang, { timeStyle: 'short' }).format(new Date(code.expiresAt)) })}</p>
        </Dialog>
      )}
    </div>
  );
}
