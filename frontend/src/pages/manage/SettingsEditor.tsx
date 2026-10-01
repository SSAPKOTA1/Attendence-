import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { ErrorBox, Field, Loading } from '../../components/ui';

/** Marks a German UI text that is translated when rendered (checked by tests/unit/i18n.test.ts like the t() calls). */
const L = (s: string) => s;

type Kind = 'num' | 'numnull' | 'bool' | 'time' | 'text' | 'textnull' | 'area' | 'list' | 'select';
interface Def { path: string; label: string; kind: Kind; hint?: string; options?: [string, string][]; step?: number }
interface Group { title: string; fields: Def[] }

const GROUPS: Group[] = [
  { title: L('Arbeitszeitrecht'), fields: [
    { path: 'legal.restPeriodMinHours', label: L('Ruhezeit zwischen Diensten (Std.)'), kind: 'num', step: 0.5 },
    { path: 'legal.limitMode', label: L('Höchstarbeitszeit prüfen'), kind: 'select', options: [['daily', L('pro Tag')], ['weekly', L('pro Woche')]] },
    { path: 'legal.dailyMaxHours', label: L('Höchstzeit pro Tag (Std.)'), kind: 'num', step: 0.5 },
    { path: 'legal.weeklyMaxHours', label: L('Höchstzeit pro Woche (Std.)'), kind: 'num', step: 0.5 },
  ] },
  { title: L('Jugendschutz'), fields: [
    { path: 'legal.minors.enforcement', label: L('Verstöße'), kind: 'select', options: [['warn', L('warnen')], ['block', L('blockieren')]] },
    { path: 'legal.minors.requireOverrideReason', label: L('Begründung zum Übergehen verlangen'), kind: 'bool' },
    { path: 'legal.minors.maxDailyHours', label: L('Höchstzeit pro Tag (Std.)'), kind: 'num', step: 0.5 },
    { path: 'legal.minors.maxWeeklyHours', label: L('Höchstzeit pro Woche (Std.)'), kind: 'num', step: 0.5 },
    { path: 'legal.minors.maxDaysPerWeek', label: L('Höchstens Tage pro Woche'), kind: 'num' },
    { path: 'legal.minors.maxShiftSpanHours', label: L('Längste Schichtspanne (Std.)'), kind: 'num', step: 0.5 },
    { path: 'legal.minors.minRestHours', label: L('Ruhezeit (Std.)'), kind: 'num', step: 0.5 },
    { path: 'legal.minors.earliestStart', label: L('Frühester Beginn'), kind: 'time' },
    { path: 'legal.minors.latestEnd', label: L('Spätestes Ende'), kind: 'time' },
    { path: 'legal.minors.latestEndHospitality16Plus', label: L('Spätestes Ende ab 16 (Gastronomie)'), kind: 'time' },
  ] },
  { title: L('Dienstplan'), fields: [
    { path: 'roster.changeNoticeHours', label: L('Kurzfristig: Änderungen weniger als … Stunden vor Dienstbeginn'), kind: 'num' },
    { path: 'roster.belowTargetOnAssign', label: L('Beim Einplanen auf Unterschreitung des Solls hinweisen'), kind: 'bool' },
    { path: 'roster.maxShiftsPerDay', label: L('Höchstens Dienste pro Tag'), kind: 'num' },
    { path: 'roster.maxDaySpanHours', label: L('Längste Tagesspanne bei geteilten Diensten (Std.)'), kind: 'num', step: 0.5 },
  ] },
  { title: L('Mitarbeiterportal'), fields: [
    { path: 'portal.planVisibility', label: L('Dienstplan sichtbar für Mitarbeitende'), kind: 'select', options: [['own_departments', L('eigene Abteilungen')], ['whole_hotel', L('ganzes Hotel')], ['own_only', L('nur eigene Dienste')]] },
    { path: 'portal.nameFormat', label: L('Namen von Kolleg:innen'), kind: 'select', options: [['first_last_initial', L('Vorname + Initiale')], ['full', L('voller Name')]] },
    { path: 'wishes.minLeadDays', label: L('Wünsche frühestens … Tage vorher (leer = beliebig)'), kind: 'numnull' },
  ] },
  { title: L('Zeiterfassung'), fields: [
    { path: 'attendance.breakMode', label: L('Pausen'), kind: 'select', options: [['auto', L('automatisch abziehen')], ['recorded', L('am Tablet erfassen')]] },
    { path: 'attendance.earlyClockInMinutes', label: L('Früh einstempeln erlaubt (Min.)'), kind: 'num' },
    { path: 'attendance.lateToleranceMinutes', label: L('Toleranz Verspätung (Min.)'), kind: 'num' },
    { path: 'attendance.overtimeToleranceMinutes', label: L('Toleranz Überstunden (Min.)'), kind: 'num' },
    { path: 'attendance.autoCloseAfterPlannedEndHours', label: L('Vergessenes Ausstempeln: Plan-Zeit nach … Std. gutschreiben (leer = aus)'), kind: 'numnull', step: 0.5 },
    { path: 'attendance.needsReviewAfterHours', label: L('Offene Einträge nach … Std. zur Prüfung'), kind: 'num', step: 0.5 },
    { path: 'attendance.pinMaxAttempts', label: L('PIN: Fehlversuche bis zur Sperre'), kind: 'num' },
    { path: 'attendance.pinLockMinutes', label: L('PIN: Sperrdauer (Min.)'), kind: 'num' },
    { path: 'attendance.kioskAllowedIps', label: L('Tablet nur von diesen IP-Adressen (kommagetrennt, leer = alle)'), kind: 'list' },
  ] },
  { title: L('Abwesenheit'), fields: [
    { path: 'absence.sickNoteRequiredFromDay', label: L('Krankschreibung ab Tag'), kind: 'num' },
    { path: 'absence.sickCreditMaxDays', label: L('Krankheitstage mit Stundengutschrift (max.)'), kind: 'num' },
    { path: 'absence.carryOverExpiresOn', label: L('Urlaubsübertrag verfällt am (MM-TT, leer = nie)'), kind: 'textnull', hint: L('z. B. 03-31') },
    { path: 'absence.maxCarryOverDays', label: L('Höchstübertrag (Tage, leer = unbegrenzt)'), kind: 'numnull', step: 0.5 },
  ] },
  { title: L('Lohn-Export'), fields: [
    { path: 'payroll.nightFrom', label: L('Nachtzuschlag ab'), kind: 'time' },
    { path: 'payroll.nightTo', label: L('Nachtzuschlag bis'), kind: 'time' },
    { path: 'payroll.datev.product', label: L('DATEV-Produkt'), kind: 'select', options: [['lodas', 'LODAS'], ['lug', 'Lohn und Gehalt']] },
    { path: 'payroll.datev.consultantNumber', label: L('Beraternummer'), kind: 'textnull', hint: L('Pflicht für den DATEV-Export') },
    { path: 'payroll.datev.clientNumber', label: L('Mandantennummer'), kind: 'textnull', hint: L('Pflicht für den DATEV-Export') },
    { path: 'payroll.datev.encoding', label: L('Zeichensatz'), kind: 'text' },
    { path: 'payroll.datev.wageTypes.worked', label: L('Lohnart: Arbeitszeit'), kind: 'textnull', hint: L('Vorschlag 2000; leer = Vorschlag') },
    { path: 'payroll.datev.wageTypes.annualLeave', label: L('Lohnart: Urlaub'), kind: 'textnull' },
    { path: 'payroll.datev.wageTypes.sick', label: L('Lohnart: Krank'), kind: 'textnull' },
    { path: 'payroll.datev.wageTypes.school', label: L('Lohnart: Berufsschule'), kind: 'textnull' },
    { path: 'payroll.datev.wageTypes.publicHoliday', label: L('Lohnart: Feiertag (Gutschrift)'), kind: 'textnull' },
    { path: 'payroll.datev.wageTypes.night', label: L('Lohnart: Nacht'), kind: 'textnull' },
    { path: 'payroll.datev.wageTypes.saturday', label: L('Lohnart: Samstag'), kind: 'textnull' },
    { path: 'payroll.datev.wageTypes.sunday', label: L('Lohnart: Sonntag'), kind: 'textnull' },
    { path: 'payroll.datev.wageTypes.holiday', label: L('Lohnart: Feiertag (Zuschlag)'), kind: 'textnull' },
    { path: 'payroll.datev.headerTemplate', label: L('Vorlage Kopfzeile'), kind: 'area', hint: L('Muster aus der Lohnbuchhaltung übernehmen') },
    { path: 'payroll.datev.recordDescriptionTemplate', label: L('Vorlage Satzbeschreibung'), kind: 'area' },
    { path: 'payroll.datev.lineTemplate', label: L('Vorlage Zeile'), kind: 'text' },
  ] },
  { title: L('Aufbewahrung'), fields: [
    { path: 'retention.timeRecordsYears', label: L('Zeiterfassung aufbewahren (Jahre)'), kind: 'num' },
    { path: 'retention.inquiriesMonths', label: L('Fragen aufbewahren (Monate)'), kind: 'num' },
  ] },
];

const getPath = (o: any, path: string) => path.split('.').reduce((a, k) => a?.[k], o);
function setPath(o: any, path: string, v: unknown) {
  const next = structuredClone(o);
  const keys = path.split('.');
  let cur = next;
  for (const k of keys.slice(0, -1)) cur = cur[k];
  cur[keys[keys.length - 1]] = v;
  return next;
}

/** Hotel settings (O8/O9): everyone with access reads, only admins write; the server validates the whole object. */
export default function SettingsEditor({ hotelId }: { hotelId: number }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['setup', 'settings', hotelId], queryFn: () => get(`/hotels/${hotelId}/settings`) });
  const [s, setS] = useState<any>(null);
  useEffect(() => { if (q.data) setS(q.data); }, [q.data]);
  const save = useMutation({ mutationFn: () => put(`/hotels/${hotelId}/settings`, s), onSuccess: () => qc.invalidateQueries({ queryKey: ['setup'] }) });
  if (q.isLoading || !s) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const set = (path: string, v: unknown) => setS((p: any) => setPath(p, path, v));

  const input = (d: Def, id: string) => {
    const v = getPath(s, d.path);
    const dis = !admin;
    switch (d.kind) {
      case 'bool': return <input id={id} type="checkbox" disabled={dis} checked={!!v} onChange={(e) => set(d.path, e.target.checked)} />;
      case 'num': return <input id={id} className="input narrow" type="number" step={d.step ?? 1} disabled={dis} value={v ?? ''} onChange={(e) => set(d.path, e.target.value === '' ? 0 : Number(e.target.value))} />;
      case 'numnull': return <input id={id} className="input narrow" type="number" step={d.step ?? 1} disabled={dis} value={v ?? ''} onChange={(e) => set(d.path, e.target.value === '' ? null : Number(e.target.value))} />;
      case 'time': return <input id={id} className="input narrow" type="time" disabled={dis} value={v ?? ''} onChange={(e) => set(d.path, e.target.value)} />;
      case 'select': return <select id={id} className="input compact" disabled={dis} value={v ?? ''} onChange={(e) => set(d.path, e.target.value)}>{d.options!.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select>;
      case 'list': return <input id={id} className="input" disabled={dis} value={(v ?? []).join(', ')} onChange={(e) => set(d.path, e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />;
      case 'area': return <textarea id={id} className="input mono" rows={4} disabled={dis} value={v ?? ''} onChange={(e) => set(d.path, e.target.value)} />;
      case 'textnull': return <input id={id} className="input" disabled={dis} placeholder={d.hint ? t(d.hint) : undefined} value={v ?? ''} onChange={(e) => set(d.path, e.target.value === '' ? null : e.target.value)} />;
      default: return <input id={id} className="input" disabled={dis} value={v ?? ''} onChange={(e) => set(d.path, e.target.value)} />;
    }
  };

  const rules = (path: string, key: 'grossOverHours' | 'workingOverHours', label: string) => (
    <fieldset className="fieldset"><legend>{label}</legend>
      {(getPath(s, path) as any[]).map((r, i) => (
        <div key={i} className="row gap wrap">
          <span>{t('ab mehr als')}</span>
          <input className="input narrow" type="number" step="0.5" aria-label={t('Stunden')} disabled={!admin} value={r[key]} onChange={(e) => set(path, getPath(s, path).map((x: any, j: number) => (j === i ? { ...x, [key]: Number(e.target.value) } : x)))} />
          <span>{t('Std. mindestens')}</span>
          <input className="input narrow" type="number" aria-label={t('Minuten Pause')} disabled={!admin} value={r.minMinutes} onChange={(e) => set(path, getPath(s, path).map((x: any, j: number) => (j === i ? { ...x, minMinutes: Number(e.target.value) } : x)))} />
          <span>{t('Min. Pause')}</span>
          {admin && <button type="button" className="btn btn-ghost" onClick={() => set(path, getPath(s, path).filter((_: any, j: number) => j !== i))}>{t('Entfernen')}</button>}
        </div>
      ))}
      {admin && <button type="button" className="btn btn-secondary self-start" onClick={() => set(path, [...getPath(s, path), { [key]: 6, minMinutes: 30 }])}>{t('Regel hinzufügen')}</button>}
    </fieldset>
  );

  return (
    <section className="section">
      <div className="section-head"><h2>{t('Hoteleinstellungen')}</h2></div>
      {!admin && <p className="muted small">{t('Einstellungen kann nur die Administration ändern.')}</p>}
      <form className="stack form-wide" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {GROUPS.map((g) => (
          <fieldset key={g.title} className="fieldset"><legend>{t(g.title)}</legend>
            {g.fields.map((d) => (
              d.kind === 'bool'
                ? <label key={d.path} className="check">{input(d, d.path)} {t(d.label)}</label>
                : <Field key={d.path} label={t(d.label)}>{(id) => input(d, id)}</Field>
            ))}
            {g.title === L('Arbeitszeitrecht') && rules('legal.breakRules', 'grossOverHours', t('Pausenregeln (Bruttozeit)'))}
            {g.title === L('Jugendschutz') && rules('legal.minors.breakRules', 'workingOverHours', t('Pausenregeln (Nettozeit)'))}
          </fieldset>
        ))}
        <ErrorBox error={save.error} />
        {save.isSuccess && <p className="ok" role="status">{t('Gespeichert.')}</p>}
        {admin && <button className="btn btn-primary self-start" disabled={save.isPending}>{t('Einstellungen speichern')}</button>}
      </form>
    </section>
  );
}
