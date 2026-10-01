import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, getAll, patch, post } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { addDays, fmtDate, isoWeek, todayLocal, weekDays, weekStart } from '../../lib/format';
import { useHotel } from '../../components/hotel';
import { Dialog, ErrorBox, Field, Loading, Tag, Warnings } from '../../components/ui';
import type { Department, Employee, ScheduleEntry, Shift } from '../../lib/types';

const name = (e: { firstName?: string; lastName?: string; displayName?: string }) => e.displayName ?? `${e.firstName ?? ''} ${e.lastName ?? ''}`.trim();

export default function Roster() {
  const { t, lang } = useI18n();
  const { hotel } = useHotel();
  const qc = useQueryClient();
  const [start, setStart] = useState(() => weekStart(todayLocal()));
  const [dept, setDept] = useState<number | ''>('');
  const [cell, setCell] = useState<{ employee: Employee; date: string } | null>(null);
  const [edit, setEdit] = useState<ScheduleEntry | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const days = weekDays(start);
  const hid = hotel?.id;
  const key = [hid, start, dept];

  const employees = useQuery({ queryKey: ['roster', 'employees', hid, 'active'], enabled: !!hid, queryFn: () => getAll<Employee>('/employees', { hotelId: hid, status: 'active' }) });
  const shifts = useQuery({ queryKey: ['roster', 'shifts', hid], enabled: !!hid, queryFn: () => getAll<Shift>('/shifts', { hotelId: hid }) });
  const depts = useQuery({ queryKey: ['roster', 'depts', hid], enabled: !!hid, queryFn: () => getAll<Department>('/departments', { hotelId: hid }) });
  const sched = useQuery({ queryKey: ['roster', 'sched', ...key], enabled: !!hid, queryFn: () => get('/schedules', { hotelId: hid, from: days[0], to: days[6], departmentId: dept }).then((r) => r.data as ScheduleEntry[]) });
  const absences = useQuery({ queryKey: ['roster', 'abs', hid, start], enabled: !!hid, queryFn: () => get('/time-offs', { hotelId: hid, from: days[0], to: days[6], status: 'approved' }).then((r) => r.data as any[]) });
  const coverage = useQuery({ queryKey: ['roster', 'cov', ...key], enabled: !!hid, queryFn: () => get('/schedules/coverage', { hotelId: hid, from: days[0], to: days[6], departmentId: dept }).then((r) => r.data as any[]) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['roster'] });
  const publish = useMutation({ mutationFn: () => post('/schedules/publish', { hotelId: hid, from: days[0], to: days[6], ...(dept ? { departmentId: dept } : {}) }), onSuccess: refresh });
  const unpublish = useMutation({ mutationFn: () => post('/schedules/unpublish', { hotelId: hid, from: days[0], to: days[6], ...(dept ? { departmentId: dept } : {}) }), onSuccess: refresh });

  const deptOf = useMemo(() => new Map((depts.data ?? []).map((d) => [d.id, d])), [depts.data]);
  const visible = useMemo(() => {
    const list = employees.data ?? [];
    if (!dept) return list;
    const withEntries = new Set((sched.data ?? []).map((e) => e.employee.id));
    return list.filter((e) => e.departments?.some((d) => d.id === dept) || withEntries.has(e.id));
  }, [employees.data, dept, sched.data]);
  const entries = sched.data ?? [];
  const drafts = entries.filter((e) => e.status === 'draft').length;
  const allWarnings = entries.flatMap((e) => (e.warnings ?? []).map((w) => ({ e, w })));
  const under = (coverage.data ?? []).filter((c) => c.understaffed);
  const isPublished = entries.length > 0 && drafts === 0;

  if (!hotel) return <Loading />;
  return (
    <div className="page roster">
      <header className="page-head">
        <div>
          <div className="row gap"><span className="kicker">{t('Woche {n}', { n: isoWeek(start) })} · {hotel.name}</span>
            <Tag kind={drafts ? 'accent' : 'neutral'}>{entries.length === 0 ? t('leer') : drafts ? t('{n} Entwürfe', { n: drafts }) : t('veröffentlicht')}</Tag></div>
          <h1>{fmtDate(days[0], lang, { day: 'numeric', month: 'short' })} – {fmtDate(days[6], lang, { day: 'numeric', month: 'short', year: 'numeric' })}</h1>
        </div>
      </header>
      <div className="toolbar noprint">
        <div className="row gap wrap">
          <button className="btn btn-secondary btn-icon" aria-label={t('Vorherige Woche')} onClick={() => setStart(addDays(start, -7))}>‹</button>
          <button className="btn btn-secondary" onClick={() => setStart(weekStart(todayLocal()))}>{t('Heute')}</button>
          <button className="btn btn-secondary btn-icon" aria-label={t('Nächste Woche')} onClick={() => setStart(addDays(start, 7))}>›</button>
          <select className="input compact" aria-label={t('Abteilung')} value={dept} onChange={(e) => setDept(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('Alle Abteilungen')}</option>
            {(depts.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="row gap wrap">
          <button className="btn btn-secondary" onClick={() => setCopyOpen(true)}>{t('Woche kopieren')}</button>
          <button className="btn btn-secondary" onClick={() => window.print()}>{t('Drucken / PDF')}</button>
          {isPublished
            ? <button className="btn btn-secondary" onClick={() => unpublish.mutate()} disabled={unpublish.isPending}>{t('Zurückziehen')}</button>
            : <button className="btn btn-primary" onClick={() => publish.mutate()} disabled={publish.isPending || entries.length === 0}>{t('Veröffentlichen')}</button>}
        </div>
      </div>
      <ErrorBox error={publish.error ?? unpublish.error} />

      {employees.isLoading || sched.isLoading ? <Loading /> : (
        <div className="roster-layout">
          <div className="grid-wrap">
            <table className="grid" aria-label={t('Dienstplan')}>
              <thead>
                <tr><th className="sticky">{t('Mitarbeiter')}</th>{days.map((d) => <th key={d} className={d === todayLocal() ? 'is-today' : ''}>{fmtDate(d, lang)}</th>)}</tr>
              </thead>
              <tbody>
                {visible.map((emp) => (
                  <tr key={emp.id}>
                    <th className="sticky rowhead" scope="row">{name(emp)}{emp.isHome === false && <Tag kind="outline" title={t('Springer')}>{t('Springer')}</Tag>}</th>
                    {days.map((d) => {
                      const es = entries.filter((e) => e.employee.id === emp.id && e.date === d);
                      const abs = (absences.data ?? []).find((a) => a.employeeId === emp.id && a.startDate <= d && a.endDate >= d);
                      return (
                        <td key={d} className="cell" onClick={() => setCell({ employee: emp, date: d })}>
                          {abs && <span className="chip chip-abs">{abs.status === 'unavailable' ? t('nicht verfügbar') : t('Abwesend')}</span>}
                          {es.map((e) => (
                            <button key={e.id} className={`chip ${e.status === 'draft' ? 'chip-draft' : ''} ${e.warnings?.length ? 'chip-warn' : ''}`}
                              style={{ borderLeftColor: deptOf.get(e.shift?.departmentId ?? -1)?.color }}
                              onClick={(ev) => { ev.stopPropagation(); setEdit(e); }}>
                              {e.entryType === 'off' ? (e.offLabel ?? t('Frei')) : <><strong>{e.shift!.name}</strong> {e.shift!.startTime}–{e.shift!.endTime}</>}
                              {e.warnings?.length ? <span aria-label={t('Warnung')}> ⚠</span> : null}
                            </button>
                          ))}
                          <button className="cell-add noprint" aria-label={t('Dienst hinzufügen')} onClick={(ev) => { ev.stopPropagation(); setCell({ employee: emp, date: d }); }}>+</button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><th className="sticky">{t('Besetzung')}</th>{days.map((d) => {
                  const u = (coverage.data ?? []).filter((c) => c.date === d && c.understaffed);
                  return <td key={d} className={u.length ? 'cov bad' : 'cov'}>{u.length ? u.map((c) => `${c.shiftName} ${c.scheduled}/${c.minStaff}`).join(', ') : '✓'}</td>;
                })}</tr>
              </tfoot>
            </table>
          </div>
          <aside className="side noprint" aria-label={t('Hinweise')}>
            <h2>{t('Hinweise')}</h2>
            {under.length === 0 && allWarnings.length === 0 && <p className="muted">{t('Keine Hinweise für diese Woche.')}</p>}
            {under.length > 0 && <><h3>{t('Unterbesetzt')}</h3><ul className="plain">{under.map((c, i) => <li key={i}>{fmtDate(c.date, lang)} · {c.shiftName} {c.scheduled}/{c.minStaff}</li>)}</ul></>}
            {allWarnings.length > 0 && <><h3>{t('Warnungen')}</h3><ul className="plain">{allWarnings.map(({ e, w }, i) => <li key={i}><strong>{name(e.employee)}</strong>, {fmtDate(e.date, lang)}<div className="muted small">{w.message ?? w.type}</div></li>)}</ul></>}
          </aside>
        </div>
      )}
      {cell && hid && <AddDialog hotelId={hid} shifts={shifts.data ?? []} cell={cell} onClose={() => setCell(null)} onSaved={() => { setCell(null); refresh(); }} />}
      {edit && hid && <EditDialog entry={edit} hotelId={hid} shifts={shifts.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} />}
      {copyOpen && hid && <CopyDialog hotelId={hid} start={start} onClose={() => setCopyOpen(false)} onSaved={() => { setCopyOpen(false); setStart(addDays(start, 7)); refresh(); }} />}
    </div>
  );
}

function AddDialog({ hotelId, shifts, cell, onClose, onSaved }: { hotelId: number; shifts: Shift[]; cell: { employee: Employee; date: string }; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [shiftId, setShiftId] = useState<string>('');
  const [off, setOff] = useState(false);
  const [reason, setReason] = useState('');
  const body = { hotelId, entryType: off ? 'off' : 'shift', employeeId: cell.employee.id, date: cell.date, ...(off ? { offLabel: t('Frei') } : { shiftId: Number(shiftId) }), ...(reason.trim() ? { overrideReason: reason.trim() } : {}) };
  const ready = off || !!shiftId;
  const check = useQuery({ queryKey: ['validate', hotelId, cell.employee.id, cell.date, shiftId, off], enabled: ready, retry: false, queryFn: () => post('/schedules/validate', { ...body, overrideReason: undefined }) });
  const save = useMutation({ mutationFn: () => post('/schedules', body), onSuccess: onSaved });
  const needsReason = !!check.data?.overrideReasonRequired || (save.error as any)?.code === 'OVERRIDE_REASON_REQUIRED';
  return (
    <Dialog title={`${name(cell.employee)} · ${fmtDate(cell.date, lang, { weekday: 'long', day: 'numeric', month: 'long' })}`} onClose={onClose}
      actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button><button className="btn btn-primary" disabled={!ready || save.isPending || (needsReason && !reason.trim())} onClick={() => save.mutate()}>{t('Eintragen')}</button></>}>
      <div className="stack">
        <Field label={t('Dienst')}>{(i) => (
          <select id={i} className="input" value={off ? 'off' : shiftId} onChange={(e) => { const v = e.target.value; setOff(v === 'off'); setShiftId(v === 'off' ? '' : v); }}>
            <option value="">{t('– wählen –')}</option>
            {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} {s.startTime}–{s.endTime}</option>)}
            <option value="off">{t('Frei')}</option>
          </select>
        )}</Field>
        {check.isFetching && <p className="muted small">{t('Prüfe Regeln …')}</p>}
        <Warnings items={check.data?.warnings} />
        <ErrorBox error={check.error ?? save.error} />
        {needsReason && <Field label={t('Begründung (nötig)')}>{(i) => <textarea id={i} className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
        {!needsReason && (check.data?.warnings?.length ?? 0) > 0 && <Field label={t('Begründung (optional)')}>{(i) => <input id={i} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
      </div>
    </Dialog>
  );
}

function EditDialog({ entry, hotelId, shifts, onClose, onSaved }: { entry: ScheduleEntry; hotelId: number; shifts: Shift[]; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [shiftId, setShiftId] = useState(String(entry.shift?.id ?? ''));
  const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => patch(`/schedules/${entry.id}`, { shiftId: Number(shiftId), ...(reason.trim() ? { overrideReason: reason.trim() } : {}) }), onSuccess: onSaved });
  const remove = useMutation({ mutationFn: () => del(`/schedules/${entry.id}`), onSuccess: onSaved });
  const cands = useQuery({ queryKey: ['cands', entry.id], enabled: entry.entryType === 'shift', queryFn: () => get('/schedules/candidates', { hotelId, date: entry.date, shiftId: entry.shift!.id }).then((r) => r.data as any[]) });
  return (
    <Dialog title={`${name(entry.employee)} · ${fmtDate(entry.date, lang, { weekday: 'long', day: 'numeric', month: 'long' })}`} onClose={onClose}
      actions={<><button className="btn btn-ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>{t('Löschen')}</button><button className="btn btn-secondary" onClick={onClose}>{t('Schließen')}</button>
        {entry.entryType === 'shift' && <button className="btn btn-primary" disabled={save.isPending || shiftId === String(entry.shift?.id)} onClick={() => save.mutate()}>{t('Speichern')}</button>}</>}>
      <div className="stack">
        <div><Tag kind={entry.status === 'draft' ? 'accent' : 'neutral'}>{entry.status === 'draft' ? t('Entwurf') : t('Veröffentlicht')}</Tag></div>
        {entry.entryType === 'shift' && (
          <Field label={t('Dienst')}>{(i) => <select id={i} className="input" value={shiftId} onChange={(e) => setShiftId(e.target.value)}>{shifts.map((s) => <option key={s.id} value={s.id}>{s.name} {s.startTime}–{s.endTime}</option>)}</select>}</Field>
        )}
        <Warnings items={entry.warnings} />
        <Field label={t('Begründung (falls nötig)')}>{(i) => <input id={i} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <ErrorBox error={save.error ?? remove.error} />
        {(cands.data?.length ?? 0) > 0 && (
          <div><h3>{t('Mögliche Vertretung')}</h3><ul className="plain">{cands.data!.slice(0, 5).map((c: any) => <li key={c.employee.id}>{c.employee.displayName} <span className="muted small">{c.weeklyHoursSoFar} h{c.isFloating ? ` · ${t('Springer')}` : ''}</span></li>)}</ul></div>
        )}
      </div>
    </Dialog>
  );
}

function CopyDialog({ hotelId, start, onClose, onSaved }: { hotelId: number; start: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [target, setTarget] = useState(addDays(start, 7));
  const copy = useMutation({ mutationFn: () => post('/schedules/copy', { hotelId, sourceFrom: start, sourceTo: addDays(start, 6), targetFrom: target, overwrite: false }), onSuccess: onSaved });
  const r = copy.data;
  return (
    <Dialog title={t('Woche kopieren')} onClose={onClose}
      actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button><button className="btn btn-primary" disabled={copy.isPending} onClick={() => copy.mutate()}>{t('Als Entwurf kopieren')}</button></>}>
      <div className="stack">
        <Field label={t('Zielwoche beginnt am (Montag)')}>{(i) => <input id={i} className="input" type="date" value={target} onChange={(e) => setTarget(e.target.value)} />}</Field>
        <p className="muted small">{t('Es werden Entwürfe erzeugt; Abwesenheiten und bestehende Einträge werden übersprungen.')}</p>
        <ErrorBox error={copy.error} />
        {r && <p role="status">{t('{n} kopiert, {m} übersprungen.', { n: r.summary?.created ?? 0, m: r.skipped?.length ?? 0 })}</p>}
      </div>
    </Dialog>
  );
}
