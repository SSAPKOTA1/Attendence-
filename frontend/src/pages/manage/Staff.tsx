import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { get, getAll, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { useHotel } from '../../components/hotel';
import { Dialog, Empty, ErrorBox, Field, Loading, Tag } from '../../components/ui';
import type { Department, Employee } from '../../lib/types';

export const EMPLOYMENT: Record<string, string> = { full_time: 'Vollzeit', part_time: 'Teilzeit', mini_job: 'Minijob', working_student: 'Werkstudent', apprentice: 'Auszubildende', intern: 'Praktikum', other: 'Sonstige' };
const WEEKDAYS = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']] as const;

export default function Staff() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { hotel } = useHotel();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['staff', hotel?.id, status, search], enabled: !!hotel, queryFn: () => get('/employees', { hotelId: hotel!.id, status, search, limit: 100 }) });
  if (!hotel) return <Loading />;
  return (
    <div className="page">
      <header className="page-head">
        <div><div className="kicker">{hotel.name}</div><h1>{t('Mitarbeiter')}</h1></div>
        {user?.role === 'admin' && <button className="btn btn-primary" onClick={() => setCreating(true)}>{t('Mitarbeiter anlegen')}</button>}
      </header>
      <div className="row gap wrap filters">
        <Field label={t('Suche')}>{(i) => <input id={i} className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
        <Field label={t('Status')}>{(i) => <select id={i} className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">{t('Aktiv')}</option><option value="on_leave">{t('Beurlaubt')}</option><option value="terminated">{t('Ausgeschieden')}</option></select>}</Field>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (q.data?.data ?? []).length === 0 ? <Empty>{t('Keine Mitarbeitenden.')}</Empty> : (
        <table className="table">
          <thead><tr><th>{t('Name')}</th><th>{t('Nr.')}</th><th>{t('Beschäftigung')}</th><th>{t('Abteilungen')}</th><th>{t('Stammhaus')}</th></tr></thead>
          <tbody>
            {q.data.data.map((e: Employee) => (
              <tr key={e.id}>
                <td><Link to={`/manage/staff/${e.id}`}><strong>{e.firstName} {e.lastName}</strong></Link>{e.isHome === false && <> <Tag kind="outline">{t('Springer')}</Tag></>}</td>
                <td className="muted">{e.employeeNumber ?? '–'}</td>
                <td>{t(EMPLOYMENT[e.employmentType ?? ''] ?? e.employmentType ?? '')}{e.payType && <span className="muted"> · {e.payType === 'salary' ? t('Gehalt') : t('Stundenlohn')}</span>}</td>
                <td>{(e.departments ?? []).map((d) => d.name).join(', ')}</td>
                <td className="muted">{e.hotels?.find((h) => h.isHome)?.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { hotels, hotel } = useHotel();
  const [f, setF] = useState({
    firstName: '', lastName: '', email: '', phone: '', employeeNumber: '', birthDate: '', hiredOn: '', hourlyRate: '', employmentType: 'full_time',
    payType: 'salary', publicHolidaysOff: true, homeHotelId: hotel?.id ?? 0, workWeekdays: [1, 2, 3, 4, 5] as number[], departmentIds: [] as number[],
    vacationDaysPerYear: '30', carriedOverDays: '0', remainingThisYearDays: '30',
  });
  const set = (k: keyof typeof f, v: any) => setF((p) => ({ ...p, [k]: v }));
  const depts = useQuery({ queryKey: ['depts-all', f.homeHotelId], enabled: !!f.homeHotelId, queryFn: () => getAll<Department>('/departments', { hotelId: f.homeHotelId }) });
  const create = useMutation({
    mutationFn: () => post('/employees', {
      firstName: f.firstName, lastName: f.lastName, payType: f.payType, publicHolidaysOff: f.publicHolidaysOff, homeHotelId: Number(f.homeHotelId),
      workWeekdays: f.workWeekdays, employmentType: f.employmentType, departmentIds: f.departmentIds,
      ...(f.email ? { email: f.email } : {}), ...(f.phone ? { phone: f.phone } : {}), ...(f.employeeNumber ? { employeeNumber: f.employeeNumber } : {}),
      ...(f.birthDate ? { birthDate: f.birthDate } : {}), ...(f.hiredOn ? { hiredOn: f.hiredOn } : {}), ...(f.hourlyRate ? { hourlyRate: Number(f.hourlyRate) } : {}),
      vacation: { vacationDaysPerYear: Number(f.vacationDaysPerYear), carriedOverDays: Number(f.carriedOverDays), remainingThisYearDays: Number(f.remainingThisYearDays) },
    }),
    onSuccess: (e) => { qc.invalidateQueries({ queryKey: ['staff'] }); qc.invalidateQueries({ queryKey: ['roster'] }); nav(`/manage/staff/${e.id}`); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  const toggle = (k: 'workWeekdays' | 'departmentIds', v: number) => set(k, f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v]);
  const taken = Number(f.vacationDaysPerYear) - Number(f.remainingThisYearDays);
  return (
    <Dialog title={t('Mitarbeiter anlegen')} onClose={onClose}
      actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button><button className="btn btn-primary" form="newemp" disabled={create.isPending || taken < 0}>{t('Anlegen')}</button></>}>
      <form id="newemp" className="stack" onSubmit={submit}>
        <div className="row gap wrap">
          <Field label={t('Vorname')}>{(i) => <input id={i} className="input" required value={f.firstName} onChange={(e) => set('firstName', e.target.value)} />}</Field>
          <Field label={t('Nachname')}>{(i) => <input id={i} className="input" required value={f.lastName} onChange={(e) => set('lastName', e.target.value)} />}</Field>
        </div>
        <div className="row gap wrap">
          <Field label={t('E-Mail')}>{(i) => <input id={i} className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />}</Field>
          <Field label={t('Telefon')}>{(i) => <input id={i} className="input" value={f.phone} onChange={(e) => set('phone', e.target.value)} />}</Field>
        </div>
        <div className="row gap wrap">
          <Field label={t('Personalnummer')}>{(i) => <input id={i} className="input" value={f.employeeNumber} onChange={(e) => set('employeeNumber', e.target.value)} />}</Field>
          <Field label={t('Geburtsdatum')}>{(i) => <input id={i} className="input" type="date" value={f.birthDate} onChange={(e) => set('birthDate', e.target.value)} />}</Field>
          <Field label={t('Eintritt')}>{(i) => <input id={i} className="input" type="date" value={f.hiredOn} onChange={(e) => set('hiredOn', e.target.value)} />}</Field>
        </div>
        <div className="row gap wrap">
          <Field label={t('Stammhaus')}>{(i) => <select id={i} className="input" value={f.homeHotelId} onChange={(e) => { set('homeHotelId', Number(e.target.value)); set('departmentIds', []); }}>{hotels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>}</Field>
          <Field label={t('Beschäftigung')}>{(i) => <select id={i} className="input" value={f.employmentType} onChange={(e) => set('employmentType', e.target.value)}>{Object.entries(EMPLOYMENT).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</select>}</Field>
        </div>
        <fieldset className="fieldset"><legend>{t('Abteilungen')}</legend>
          {(depts.data ?? []).map((d) => <label key={d.id} className="check"><input type="checkbox" checked={f.departmentIds.includes(d.id)} onChange={() => toggle('departmentIds', d.id)} /> {d.name}</label>)}
        </fieldset>
        <fieldset className="fieldset"><legend>{t('Arbeitstage')}</legend>
          {WEEKDAYS.map(([n, l]) => <label key={n} className="check"><input type="checkbox" checked={f.workWeekdays.includes(n)} onChange={() => toggle('workWeekdays', n)} /> {t(l)}</label>)}
        </fieldset>
        <fieldset className="fieldset"><legend>{t('Vergütung')}</legend>
          <div className="seg" role="radiogroup" aria-label={t('Vergütung')}>
            {[['salary', t('Gehalt (Arbeitszeitkonto)')], ['hourly', t('Stundenlohn')]].map(([k, l]) => (
              <button type="button" key={k} role="radio" aria-checked={f.payType === k} className={`seg-btn${f.payType === k ? ' is-on' : ''}`} onClick={() => set('payType', k)}>{l}</button>
            ))}
          </div>
          {f.payType === 'hourly' && <Field label={t('Stundenlohn (€)')}>{(i) => <input id={i} className="input" type="number" min={0} step="0.01" value={f.hourlyRate} onChange={(e) => set('hourlyRate', e.target.value)} />}</Field>}
          <label className="check"><input type="checkbox" checked={f.publicHolidaysOff} onChange={(e) => set('publicHolidaysOff', e.target.checked)} /> {t('Hat an Feiertagen frei (Gutschrift)')}</label>
        </fieldset>
        <fieldset className="fieldset"><legend>{t('Urlaub (Startwerte)')}</legend>
          <div className="row gap wrap">
            <Field label={t('Urlaubstage pro Jahr')}>{(i) => <input id={i} className="input" type="number" min={0} step="0.5" value={f.vacationDaysPerYear} onChange={(e) => { set('vacationDaysPerYear', e.target.value); set('remainingThisYearDays', e.target.value); }} />}</Field>
            <Field label={t('Rest aus dem Vorjahr')}>{(i) => <input id={i} className="input" type="number" min={0} step="0.5" value={f.carriedOverDays} onChange={(e) => set('carriedOverDays', e.target.value)} />}</Field>
            <Field label={t('Davon dieses Jahr noch übrig')} hint={taken >= 0 ? t('Schon genommen: {n} Tage', { n: taken }) : t('Mehr als der Jahresanspruch')}>{(i) => <input id={i} className="input" type="number" min={0} step="0.5" value={f.remainingThisYearDays} onChange={(e) => set('remainingThisYearDays', e.target.value)} />}</Field>
          </div>
          <p className="muted small">{t('Der Rest wird in jedem neuen Jahr automatisch übertragen.')}</p>
        </fieldset>
        <ErrorBox error={create.error} />
      </form>
    </Dialog>
  );
}
