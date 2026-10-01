import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { addDays, fmtDate, fmtMinutes, fmtTime, todayLocal } from '../../lib/format';
import { useHotel } from '../../components/hotel';
import { useHotelEmployees } from '../../components/employees';
import { Dialog, Empty, ErrorBox, Field, Loading, Tag } from '../../components/ui';
import { ANOMALY, APPROVAL } from '../portal/Attendance';
import { instantToLocal, localToInstant } from '../../lib/zone';
import CloseEntryDialog from './CloseEntryDialog';

export default function ManageAttendance() {
  const { t, lang } = useI18n();
  const { hotel } = useHotel();
  const hid = hotel?.id;
  const tz = hotel?.timezone ?? 'Europe/Berlin';
  const [from, setFrom] = useState(addDays(todayLocal(), -13));
  const [to, setTo] = useState(todayLocal());
  const [emp, setEmp] = useState('');
  const [status, setStatus] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const { data: employees, nameOf } = useHotelEmployees(hid);
  const q = useQuery({
    queryKey: ['mattendance', hid, from, to, emp, status], enabled: !!hid,
    queryFn: () => get('/attendance', { hotelId: hid, from, to, employeeId: emp, status, limit: 100 }),
  });
  if (!hotel) return <Loading />;
  return (
    <div className="page">
      <header className="page-head"><div><div className="kicker">{hotel.name}</div><h1>{t('Zeiten')}</h1></div><button className="btn btn-primary" onClick={() => setAdding(true)}>{t('Eintrag nachtragen')}</button></header>
      <div className="row gap wrap filters">
        <Field label={t('Von')}>{(i) => <input id={i} className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('Bis')}>{(i) => <input id={i} className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label={t('Mitarbeiter')}>{(i) => <select id={i} className="input" value={emp} onChange={(e) => setEmp(e.target.value)}><option value="">{t('Alle')}</option>{(employees ?? []).map((x) => <option key={x.id} value={x.id}>{x.firstName} {x.lastName}</option>)}</select>}</Field>
        <Field label={t('Status')}>{(i) => <select id={i} className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('Alle')}</option><option value="open">{t('Offen')}</option><option value="needs_review">{t('Prüfung')}</option><option value="closed">{t('Geschlossen')}</option></select>}</Field>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (q.data?.data ?? []).length === 0 ? <Empty>{t('Keine Einträge.')}</Empty> : (
        <table className="table">
          <thead><tr><th>{t('Datum')}</th><th>{t('Mitarbeiter')}</th><th>{t('Von – bis')}</th><th>{t('Pause')}</th><th>{t('Gearbeitet')}</th><th>{t('Hinweise')}</th><th /></tr></thead>
          <tbody>
            {q.data.data.map((e: any) => (
              <tr key={e.id}>
                <td>{fmtDate(instantToLocal(e.clockInAt, tz).slice(0, 10), lang)}</td>
                <td><strong>{e.employee?.displayName ?? nameOf(e.employeeId)}</strong></td>
                <td>{fmtTime(e.clockInAt, tz, lang)} – {e.clockOutAt ? fmtTime(e.clockOutAt, tz, lang) : t('offen')}</td>
                <td>{e.breakMinutes} min</td><td>{fmtMinutes(e.workedMinutes)}</td>
                <td className="tags">
                  {e.status === 'needs_review' && <Tag kind="accent">{t('Prüfung')}</Tag>}
                  {e.approvalStatus && e.approvalStatus !== 'not_required' && <Tag kind={e.approvalStatus === 'approved' ? 'neutral' : 'accent'} title={e.unplannedReason ?? undefined}>{t(APPROVAL[e.approvalStatus])}</Tag>}
                  {e.anomalies.map((a: any, i: number) => <Tag key={i} kind="outline">{t(ANOMALY[a.type] ?? a.type)}</Tag>)}
                </td>
                <td><button className="btn btn-ghost" onClick={() => setEdit(e)}>{t('Bearbeiten')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <CloseEntryDialog entryId={edit.id} clockInAt={edit.clockInAt} clockOutAt={edit.clockOutAt} breakMinutes={edit.breakMinutes} tz={tz} onClose={() => setEdit(null)} />}
      {adding && <AddEntry hotelId={hotel.id} tz={tz} employees={employees ?? []} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddEntry({ hotelId, tz, employees, onClose }: { hotelId: number; tz: string; employees: any[]; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [emp, setEmp] = useState('');
  const day = todayLocal();
  const [inAt, setIn] = useState(`${day}T`);
  const [out, setOut] = useState(`${day}T`);
  const [brk, setBrk] = useState('0');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => post('/attendance', { hotelId, employeeId: Number(emp), clockInAt: localToInstant(inAt, tz), ...(out.length === 16 ? { clockOutAt: localToInstant(out, tz) } : {}), breakMinutes: Number(brk), reason }),
    onSuccess: () => { qc.invalidateQueries(); onClose(); },
  });
  return (
    <Dialog title={t('Eintrag nachtragen')} onClose={onClose}
      actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button><button className="btn btn-primary" disabled={save.isPending || !emp || inAt.length < 16 || !reason.trim()} onClick={() => save.mutate()}>{t('Speichern')}</button></>}>
      <div className="stack">
        <Field label={t('Mitarbeiter')}>{(i) => <select id={i} className="input" value={emp} onChange={(e) => setEmp(e.target.value)}><option value="">{t('– wählen –')}</option>{employees.map((x) => <option key={x.id} value={x.id}>{x.firstName} {x.lastName}</option>)}</select>}</Field>
        <Field label={t('Eingestempelt')}>{(i) => <input id={i} className="input" type="datetime-local" value={inAt} onChange={(e) => setIn(e.target.value)} />}</Field>
        <Field label={t('Ausgestempelt')}>{(i) => <input id={i} className="input" type="datetime-local" value={out} onChange={(e) => setOut(e.target.value)} />}</Field>
        <Field label={t('Pause (Minuten)')}>{(i) => <input id={i} className="input" type="number" min={0} value={brk} onChange={(e) => setBrk(e.target.value)} />}</Field>
        <Field label={t('Begründung')}>{(i) => <textarea id={i} className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <ErrorBox error={save.error} />
      </div>
    </Dialog>
  );
}
