import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { fmtDays, fmtHours, todayLocal } from '../../lib/format';
import { Dialog, ErrorBox, Field, Loading, Section, Stat, Tag, Warnings } from '../../components/ui';
import { EMPLOYMENT } from './Staff';
import { useHotel } from '../../components/hotel';

export default function StaffDetail() {
  const { t, lang } = useI18n();
  const { id } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const e = useQuery({ queryKey: ['employee', id], queryFn: () => get(`/employees/${id}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['employee', id] }); qc.invalidateQueries({ queryKey: ['staff'] }); qc.invalidateQueries({ queryKey: ['roster'] }); };
  const emp = e.data;
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (emp) setF({ firstName: emp.firstName, lastName: emp.lastName, email: emp.email ?? '', phone: emp.phone ?? '', employeeNumber: emp.employeeNumber ?? '', employmentType: emp.employmentType, status: emp.status, payType: emp.payType, publicHolidaysOff: emp.publicHolidaysOff, hourlyRate: emp.hourlyRate ?? '', hiredOn: emp.hiredOn ?? '', terminatedOn: emp.terminatedOn ?? '' }); }, [emp]);
  const save = useMutation({
    mutationFn: () => patch(`/employees/${id}`, {
      firstName: f.firstName, lastName: f.lastName, employmentType: f.employmentType, status: f.status, payType: f.payType, publicHolidaysOff: f.publicHolidaysOff,
      email: f.email || null, phone: f.phone || null, employeeNumber: f.employeeNumber || null, hourlyRate: f.hourlyRate === '' ? null : Number(f.hourlyRate),
      hiredOn: f.hiredOn || null, terminatedOn: f.status === 'terminated' ? f.terminatedOn || todayLocal() : null,
    }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: () => del(`/employees/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['staff'] }); nav('/manage/staff'); } });
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (e.isLoading || !f) return <Loading />;
  if (e.error) return <ErrorBox error={e.error} />;
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const submit = (ev: FormEvent) => { ev.preventDefault(); save.mutate(); };
  const full = emp.hourlyRate !== undefined; // reduced view for floating staff of other hotels has no rate/contact data
  return (
    <div className="page">
      <header className="page-head">
        <div><div className="kicker"><Link to="/manage/staff">← {t('Mitarbeiter')}</Link></div><h1>{emp.firstName} {emp.lastName}</h1></div>
        <div className="row gap"><Tag kind="neutral">{emp.employeeNumber ?? '–'}</Tag><Tag kind={emp.status === 'active' ? 'accent' : 'neutral'}>{t(emp.status === 'active' ? 'Aktiv' : emp.status === 'on_leave' ? 'Beurlaubt' : 'Ausgeschieden')}</Tag></div>
      </header>
      {!full && <p className="muted">{t('Reduzierte Ansicht: Stundenlohn, Kontaktdaten und Abwesenheitsarten sieht nur die Leitung des Stammhauses.')}</p>}
      {full && (
        <Section title={t('Stammdaten')}>
          <form className="stack form-wide" onSubmit={submit}>
            <div className="row gap wrap">
              <Field label={t('Vorname')}>{(i) => <input id={i} className="input" value={f.firstName} onChange={(x) => set('firstName', x.target.value)} />}</Field>
              <Field label={t('Nachname')}>{(i) => <input id={i} className="input" value={f.lastName} onChange={(x) => set('lastName', x.target.value)} />}</Field>
              <Field label={t('Personalnummer')}>{(i) => <input id={i} className="input" value={f.employeeNumber} onChange={(x) => set('employeeNumber', x.target.value)} />}</Field>
            </div>
            <div className="row gap wrap">
              <Field label={t('E-Mail')}>{(i) => <input id={i} className="input" type="email" value={f.email} onChange={(x) => set('email', x.target.value)} />}</Field>
              <Field label={t('Telefon')}>{(i) => <input id={i} className="input" value={f.phone} onChange={(x) => set('phone', x.target.value)} />}</Field>
            </div>
            <div className="row gap wrap">
              <Field label={t('Beschäftigung')}>{(i) => <select id={i} className="input" value={f.employmentType} onChange={(x) => set('employmentType', x.target.value)}>{Object.entries(EMPLOYMENT).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</select>}</Field>
              <Field label={t('Vergütung')}>{(i) => <select id={i} className="input" value={f.payType} onChange={(x) => set('payType', x.target.value)}><option value="salary">{t('Gehalt (Arbeitszeitkonto)')}</option><option value="hourly">{t('Stundenlohn')}</option></select>}</Field>
              <Field label={t('Stundenlohn (€)')}>{(i) => <input id={i} className="input" type="number" min={0} step="0.01" value={f.hourlyRate} onChange={(x) => set('hourlyRate', x.target.value)} />}</Field>
            </div>
            <div className="row gap wrap">
              <Field label={t('Eintritt')}>{(i) => <input id={i} className="input" type="date" value={f.hiredOn} onChange={(x) => set('hiredOn', x.target.value)} />}</Field>
              <Field label={t('Status')}>{(i) => <select id={i} className="input" value={f.status} onChange={(x) => set('status', x.target.value)}><option value="active">{t('Aktiv')}</option><option value="on_leave">{t('Beurlaubt')}</option><option value="terminated">{t('Ausgeschieden')}</option></select>}</Field>
              {f.status === 'terminated' && <Field label={t('Austritt')}>{(i) => <input id={i} className="input" type="date" value={f.terminatedOn} onChange={(x) => set('terminatedOn', x.target.value)} />}</Field>}
            </div>
            <label className="check"><input type="checkbox" checked={!!f.publicHolidaysOff} onChange={(x) => set('publicHolidaysOff', x.target.checked)} /> {t('Hat an Feiertagen frei (Gutschrift)')}</label>
            <ErrorBox error={save.error} />
            <div className="row gap">
              <button className="btn btn-primary" disabled={save.isPending}>{t('Speichern')}</button>
              {save.isSuccess && <span className="ok" role="status">{t('Gespeichert.')}</span>}
              {user?.role === 'admin' && <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(true)}>{t('Löschen')}</button>}
            </div>
          </form>
        </Section>
      )}
      {full && <HotelsSection emp={emp} onSaved={refresh} />}
      {full && <AllowanceSection id={id!} lang={lang} />}
      {full && <TargetsSection id={id!} />}
      <TimeAccountSection id={id!} lang={lang} />
      {full && <PinSection id={id!} />}
      {confirmDelete && (
        <Dialog title={t('Mitarbeiter löschen?')} onClose={() => setConfirmDelete(false)}
          actions={<><button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>{t('Abbrechen')}</button><button className="btn btn-primary" onClick={() => remove.mutate()}>{t('Endgültig löschen')}</button></>}>
          <p>{t('Der Eintrag wird ausgeblendet, die Zeithistorie bleibt erhalten. Mit zukünftigen Diensten ist das Löschen nicht möglich.')}</p>
          <ErrorBox error={remove.error} />
        </Dialog>
      )}
    </div>
  );
}

function AllowanceSection({ id, lang }: { id: string; lang: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [year, setYear] = useState(Number(todayLocal().slice(0, 4)));
  const q = useQuery({ queryKey: ['allowance', id, year], queryFn: () => get(`/employees/${id}/vacation-allowance`, { year }) });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (q.data) setF({ per: String(q.data.vacationDaysPerYear), carry: String(q.data.carriedOverDays), auto: q.data.carryOverAutomatic, taken: String(q.data.alreadyTakenDays), expires: q.data.carryOverExpiresOn ?? '' }); }, [q.data]);
  const save = useMutation({
    mutationFn: () => put(`/employees/${id}/vacation-allowance`, { year, vacationDaysPerYear: Number(f.per), carriedOverDays: f.auto ? null : Number(f.carry), alreadyTakenDays: Number(f.taken), carryOverExpiresOn: f.expires || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['allowance', id] }),
  });
  const a = q.data;
  return (
    <Section title={t('Urlaub')} aside={<div className="row gap"><button className="btn btn-secondary btn-icon" aria-label={t('Vorjahr')} onClick={() => setYear(year - 1)}>‹</button><strong>{year}</strong><button className="btn btn-secondary btn-icon" aria-label={t('Nächstes Jahr')} onClick={() => setYear(year + 1)}>›</button></div>}>
      {!a || !f ? <Loading /> : (
        <>
          <div className="stats">
            <Stat label={t('Übrig')} value={fmtDays(a.remainingDays, lang)} />
            <Stat label={t('Jahresanspruch')} value={fmtDays(a.vacationDaysPerYear, lang)} />
            <Stat label={t('Übertrag')} value={fmtDays(a.carriedOverDays, lang)} sub={a.carryOverAutomatic ? t('automatisch') : t('manuell')} />
            <Stat label={t('Genommen')} value={fmtDays(a.usedDays, lang)} sub={a.pendingDays ? t('+ {n} beantragt', { n: fmtDays(a.pendingDays, lang) }) : undefined} />
          </div>
          <form className="stack form-wide" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <div className="row gap wrap">
              <Field label={t('Urlaubstage pro Jahr')}>{(i) => <input id={i} className="input" type="number" min={0} step="0.5" value={f.per} onChange={(e) => setF({ ...f, per: e.target.value })} />}</Field>
              <Field label={t('Schon vor dem Start genommen')}>{(i) => <input id={i} className="input" type="number" min={0} step="0.5" value={f.taken} onChange={(e) => setF({ ...f, taken: e.target.value })} />}</Field>
              <Field label={t('Übertrag verfällt am')}>{(i) => <input id={i} className="input" type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} />}</Field>
            </div>
            <label className="check"><input type="checkbox" checked={f.auto} onChange={(e) => setF({ ...f, auto: e.target.checked })} /> {t('Übertrag aus dem Vorjahr automatisch berechnen')}</label>
            {!f.auto && <Field label={t('Übertrag (Tage)')}>{(i) => <input id={i} className="input" type="number" min={0} step="0.5" value={f.carry} onChange={(e) => setF({ ...f, carry: e.target.value })} />}</Field>}
            <ErrorBox error={save.error} />
            <Warnings items={save.data?.warnings} />
            <button className="btn btn-secondary self-start" disabled={save.isPending}>{t('Urlaub speichern')}</button>
          </form>
        </>
      )}
    </Section>
  );
}

function TargetsSection({ id }: { id: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['targets', id], queryFn: () => get(`/employees/${id}/work-targets`) });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (q.data) setF(Object.fromEntries(Object.entries(q.data).filter(([k]) => k !== 'employeeId' && k !== 'balanceStartDate').map(([k, v]) => [k, String(v)]))); }, [q.data]);
  const save = useMutation({ mutationFn: () => put(`/employees/${id}/work-targets`, Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Number(v)]))), onSuccess: () => qc.invalidateQueries({ queryKey: ['targets', id] }) });
  if (!f) return null;
  const fields: [string, string][] = [['minHoursPerWeek', 'Min./Woche'], ['targetHoursPerWeek', 'Soll/Woche'], ['maxHoursPerWeek', 'Max./Woche'], ['minHoursPerMonth', 'Min./Monat'], ['targetHoursPerMonth', 'Soll/Monat'], ['maxHoursPerMonth', 'Max./Monat'], ['openingBalanceHours', 'Startsaldo Zeitkonto (h)']];
  return (
    <Section title={t('Sollzeiten')}>
      <form className="stack form-wide" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="row gap wrap">{fields.map(([k, l]) => <Field key={k} label={t(l)}>{(i) => <input id={i} className="input narrow" type="number" step="0.5" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</Field>)}</div>
        <ErrorBox error={save.error} />
        <button className="btn btn-secondary self-start" disabled={save.isPending}>{t('Sollzeiten speichern')}</button>
      </form>
    </Section>
  );
}

function TimeAccountSection({ id, lang }: { id: string; lang: string }) {
  const { t } = useI18n();
  const d = new Date();
  const to = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const from = `${d.getFullYear()}-${String(Math.max(1, d.getMonth() - 4)).padStart(2, '0')}`;
  const q = useQuery({ queryKey: ['timeaccount', id, from, to], queryFn: () => get(`/employees/${id}/time-account`, { from, to }) });
  if (q.isLoading) return null;
  if (q.error || !q.data) return null;
  const a = q.data;
  return (
    <Section title={t('Arbeitszeitkonto')}>
      {!a.timeAccountEnabled ? <p className="muted">{t('Stundenlohn: kein Arbeitszeitkonto.')}</p> : (
        <>
          <Stat label={t('Saldo')} value={fmtHours(a.balanceHours, lang)} />
          <table className="table"><thead><tr><th>{t('Monat')}</th><th>{t('Gearbeitet')}</th><th>{t('Gutschrift')}</th><th>{t('Soll')}</th><th>{t('Differenz')}</th></tr></thead>
            <tbody>{a.months.map((m: any) => <tr key={m.month}><td>{m.month}</td><td>{fmtHours(m.workedHours, lang)}</td><td>{fmtHours(m.creditedHours, lang)}</td><td>{fmtHours(m.targetHours, lang)}</td><td>{fmtHours(m.deltaHours, lang)}{m.openEntries ? <> <Tag kind="accent">{t('{n} offen', { n: m.openEntries })}</Tag></> : null}</td></tr>)}</tbody></table>
        </>
      )}
    </Section>
  );
}

function PinSection({ id }: { id: string }) {
  const { t } = useI18n();
  const [pin, setPin] = useState<string | null>(null);
  const reset = useMutation({ mutationFn: () => post(`/employees/${id}/pin/reset`), onSuccess: (r) => setPin(r.pin) });
  const unlock = useMutation({ mutationFn: () => post(`/employees/${id}/pin/unlock`) });
  return (
    <Section title={t('Tablet-PIN')}>
      <div className="row gap wrap">
        <button className="btn btn-secondary" onClick={() => reset.mutate()} disabled={reset.isPending}>{t('PIN zurücksetzen')}</button>
        <button className="btn btn-secondary" onClick={() => unlock.mutate()} disabled={unlock.isPending}>{t('PIN entsperren')}</button>
        {unlock.isSuccess && <span className="ok" role="status">{t('Entsperrt.')}</span>}
      </div>
      <ErrorBox error={reset.error ?? unlock.error} />
      {pin && <Dialog title={t('Neue PIN')} onClose={() => setPin(null)} actions={<button className="btn btn-primary" onClick={() => setPin(null)}>{t('Fertig')}</button>}>
        <p className="pin-show" aria-label={t('Neue PIN')}>{pin}</p><p className="muted small">{t('Wird nur jetzt angezeigt. Bitte der Person persönlich mitteilen.')}</p></Dialog>}
    </Section>
  );
}

function HotelsSection({ emp, onSaved }: { emp: any; onSaved: () => void }) {
  const { t } = useI18n();
  const { hotels } = useHotel();
  const [sel, setSel] = useState<number[]>((emp.hotels ?? []).map((h: any) => h.id));
  const [home, setHome] = useState<number>(emp.homeHotelId);
  const save = useMutation({ mutationFn: () => put(`/employees/${emp.id}/hotels`, { hotelIds: sel, homeHotelId: home }), onSuccess: onSaved });
  if (hotels.length < 2) return null;
  const toggle = (id: number) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  return (
    <Section title={t('Hotels')}>
      <p className="muted small">{t('Springer können in mehreren Hotels eingeplant werden. Das Stammhaus pflegt Daten, Lohn und Urlaub.')}</p>
      <div className="row gap wrap">
        {hotels.map((h) => (
          <div key={h.id} className="row gap">
            <label className="check"><input type="checkbox" checked={sel.includes(h.id)} onChange={() => toggle(h.id)} /> {h.name}</label>
            <label className="check"><input type="radio" name="home" disabled={!sel.includes(h.id)} checked={home === h.id} onChange={() => setHome(h.id)} /> {t('Stammhaus')}</label>
          </div>
        ))}
      </div>
      <ErrorBox error={save.error} />
      <button className="btn btn-secondary self-start" disabled={save.isPending || !sel.includes(home)} onClick={() => save.mutate()}>{t('Hotels speichern')}</button>
    </Section>
  );
}
