import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, getAll, patch, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { todayLocal } from '../../lib/format';
import { useHotel } from '../../components/hotel';
import { useHotelEmployees } from '../../components/employees';
import { Dialog, Empty, ErrorBox, Field, Loading, Tag } from '../../components/ui';
import type { Department, Shift } from '../../lib/types';

const TABS = ['shifts', 'departments', 'users', 'blackouts', 'audit'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { shifts: 'Dienste', departments: 'Abteilungen', users: 'Benutzer', blackouts: 'Urlaubssperren', audit: 'Protokoll' };

export default function Setup() {
  const { t } = useI18n();
  const { hotel } = useHotel();
  const [tab, setTab] = useState<Tab>('shifts');
  if (!hotel) return <Loading />;
  return (
    <div className="page">
      <header className="page-head"><div><div className="kicker">{hotel.name}</div><h1>{t('Einrichtung')}</h1></div></header>
      <div className="seg" role="tablist" aria-label={t('Bereich')}>
        {TABS.map((k) => <button key={k} role="tab" aria-selected={tab === k} className={`seg-btn${tab === k ? ' is-on' : ''}`} onClick={() => setTab(k)}>{t(TAB_LABEL[k])}</button>)}
      </div>
      {tab === 'shifts' && <Shifts hotelId={hotel.id} />}
      {tab === 'departments' && <Departments hotelId={hotel.id} />}
      {tab === 'users' && <Users hotelId={hotel.id} />}
      {tab === 'blackouts' && <Blackouts hotelId={hotel.id} />}
      {tab === 'audit' && <Audit hotelId={hotel.id} />}
    </div>
  );
}

const USER_STATUS: Record<string, string> = { active: 'aktiv', invited: 'eingeladen', disabled: 'gesperrt' };
const WEEKDAYS: [number, string][] = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [7, 'So']];

function Shifts({ hotelId }: { hotelId: number }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const qc = useQueryClient();
  const shifts = useQuery({ queryKey: ['setup', 'shifts', hotelId], queryFn: () => getAll<Shift>('/shifts', { hotelId }) });
  const depts = useQuery({ queryKey: ['setup', 'depts', hotelId], queryFn: () => getAll<Department>('/departments', { hotelId }) });
  const [edit, setEdit] = useState<Partial<Shift> | null>(null);
  const [staff, setStaff] = useState<Shift | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['setup'] }); qc.invalidateQueries({ queryKey: ['roster'] }); };
  const remove = useMutation({ mutationFn: (id: number) => del(`/shifts/${id}`), onSuccess: refresh });
  const deptName = (id: number) => depts.data?.find((d) => d.id === id)?.name ?? '';
  return (
    <section className="section">
      <div className="section-head"><h2>{t('Dienste')}</h2>{admin && <button className="btn btn-primary" onClick={() => setEdit({ name: '', startTime: '06:00', endTime: '14:00', breakDurationMinutes: 30, departmentId: depts.data?.[0]?.id })}>{t('Neuer Dienst')}</button>}</div>
      {!admin && <p className="muted small">{t('Dienste werden von der Administration angelegt. Du kannst den Mindestbedarf festlegen.')}</p>}
      {shifts.isLoading ? <Loading /> : (shifts.data ?? []).length === 0 ? <Empty>{t('Noch keine Dienste.')}</Empty> : (
        <table className="table">
          <thead><tr><th>{t('Name')}</th><th>{t('Abteilung')}</th><th>{t('Zeit')}</th><th>{t('Pause')}</th><th>{t('Bezahlt')}</th><th /></tr></thead>
          <tbody>
            {shifts.data!.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong></td><td>{deptName(s.departmentId)}</td><td>{s.startTime}–{s.endTime}</td><td>{s.breakDurationMinutes} min</td><td>{s.paidHours} h</td>
                <td className="row gap">
                  <button className="btn btn-ghost" onClick={() => setStaff(s)}>{t('Mindestbesetzung')}</button>
                  {admin && <><button className="btn btn-ghost" onClick={() => setEdit(s)}>{t('Bearbeiten')}</button><button className="btn btn-ghost" onClick={() => remove.mutate(s.id)}>{t('Löschen')}</button></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ErrorBox error={remove.error} />
      {edit && <ShiftDialog hotelId={hotelId} shift={edit} depts={depts.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} />}
      {staff && <StaffingDialog shift={staff} onClose={() => setStaff(null)} />}
    </section>
  );
}

function ShiftDialog({ hotelId, shift, depts, onClose, onSaved }: { hotelId: number; shift: Partial<Shift>; depts: Department[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: shift.name ?? '', departmentId: String(shift.departmentId ?? ''), startTime: shift.startTime ?? '06:00', endTime: shift.endTime ?? '14:00', brk: String(shift.breakDurationMinutes ?? 0) });
  const body = { name: f.name, departmentId: Number(f.departmentId), startTime: f.startTime, endTime: f.endTime, breakDurationMinutes: Number(f.brk) };
  const save = useMutation({ mutationFn: () => (shift.id ? patch(`/shifts/${shift.id}`, body) : post('/shifts', { hotelId, ...body })), onSuccess: onSaved });
  const sub = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  return (
    <Dialog title={shift.id ? t('Dienst bearbeiten') : t('Neuer Dienst')} onClose={onClose}
      actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button><button className="btn btn-primary" form="shiftform" disabled={save.isPending || !f.departmentId}>{t('Speichern')}</button></>}>
      <form id="shiftform" className="stack" onSubmit={sub}>
        <Field label={t('Name')}>{(i) => <input id={i} className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t('Abteilung')}>{(i) => <select id={i} className="input" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}</Field>
        <div className="row gap wrap">
          <Field label={t('Beginn')}>{(i) => <input id={i} className="input" type="time" required value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} />}</Field>
          <Field label={t('Ende')}>{(i) => <input id={i} className="input" type="time" required value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} />}</Field>
          <Field label={t('Pause (Minuten)')}>{(i) => <input id={i} className="input narrow" type="number" min={0} value={f.brk} onChange={(e) => setF({ ...f, brk: e.target.value })} />}</Field>
        </div>
        <p className="muted small">{t('Endet der Dienst vor dem Beginn, geht er über Mitternacht.')}</p>
        <ErrorBox error={save.error} />
        {(save.data?.warnings ?? []).map((w: any, i: number) => <p key={i} className="warn small">{w.message ?? w.type}</p>)}
      </form>
    </Dialog>
  );
}

function StaffingDialog({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['staffing', shift.id], queryFn: () => get(`/shifts/${shift.id}/staffing-requirements`) });
  const [vals, setVals] = useState<Record<number, string> | null>(null);
  const cur = vals ?? Object.fromEntries(WEEKDAYS.map(([n]) => [n, String(q.data?.data?.find((r: any) => r.weekday === n)?.minStaff ?? 0)]));
  const save = useMutation({
    mutationFn: () => put(`/shifts/${shift.id}/staffing-requirements`, { requirements: WEEKDAYS.filter(([n]) => Number(cur[n]) > 0).map(([n]) => ({ weekday: n, minStaff: Number(cur[n]) })) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roster'] }); onClose(); },
  });
  return (
    <Dialog title={t('Mindestbesetzung: {name}', { name: shift.name })} onClose={onClose}
      actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button><button className="btn btn-primary" disabled={save.isPending || q.isLoading} onClick={() => save.mutate()}>{t('Speichern')}</button></>}>
      <div className="stack">
        <p className="muted small">{t('Wie viele Personen müssen an welchem Wochentag mindestens eingeplant sein? 0 = kein Bedarf.')}</p>
        <div className="row gap wrap">
          {WEEKDAYS.map(([n, l]) => <Field key={n} label={t(l)}>{(i) => <input id={i} className="input narrow" type="number" min={0} value={cur[n]} onChange={(e) => setVals({ ...cur, [n]: e.target.value })} />}</Field>)}
        </div>
        <ErrorBox error={save.error} />
      </div>
    </Dialog>
  );
}

function Departments({ hotelId }: { hotelId: number }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['setup', 'depts', hotelId], queryFn: () => getAll<Department>('/departments', { hotelId }) });
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2f62b3');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['setup'] }); qc.invalidateQueries({ queryKey: ['roster'] }); };
  const create = useMutation({ mutationFn: () => post('/departments', { hotelId, name, color }), onSuccess: () => { setName(''); refresh(); } });
  const remove = useMutation({ mutationFn: (id: number) => del(`/departments/${id}`), onSuccess: refresh });
  return (
    <section className="section">
      <div className="section-head"><h2>{t('Abteilungen')}</h2></div>
      <form className="row gap wrap filters" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Field label={t('Name')}>{(i) => <input id={i} className="input" required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={t('Farbe')}>{(i) => <input id={i} className="input narrow" type="color" value={color} onChange={(e) => setColor(e.target.value)} />}</Field>
        <button className="btn btn-primary" disabled={create.isPending}>{t('Hinzufügen')}</button>
      </form>
      <ErrorBox error={create.error ?? remove.error} />
      {q.isLoading ? <Loading /> : (
        <table className="table"><tbody>
          {(q.data ?? []).map((d) => <tr key={d.id}><td><span className="swatch" style={{ background: d.color }} /> <strong>{d.name}</strong></td><td><button className="btn btn-ghost" onClick={() => remove.mutate(d.id)}>{t('Löschen')}</button></td></tr>)}
        </tbody></table>
      )}
    </section>
  );
}

function Users({ hotelId }: { hotelId: number }) {
  const { t, lang } = useI18n();
  const { user: me } = useAuth();
  const { hotels } = useHotel();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['setup', 'users'], queryFn: () => getAll<any>('/users') });
  const { data: emps } = useHotelEmployees(hotelId);
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<{ title: string; url: string; expiresAt: string } | null>(null);
  const [accessFor, setAccessFor] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['setup', 'users'] });
  const invite = useMutation({ mutationFn: (id: number) => post(`/users/${id}/invite`, { deliver: 'link' }), onSuccess: (r) => setLink({ title: t('Einladungslink'), url: r.inviteUrl, expiresAt: r.expiresAt }) });
  const reset = useMutation({ mutationFn: (id: number) => post(`/users/${id}/password-reset-link`), onSuccess: (r) => setLink({ title: t('Link zum Zurücksetzen'), url: r.resetUrl, expiresAt: r.expiresAt }) });
  const toggle = useMutation({ mutationFn: (u: any) => patch(`/users/${u.id}`, { status: u.status === 'disabled' ? 'active' : 'disabled' }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: number) => del(`/users/${id}`), onSuccess: refresh });
  const label = (u: any) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.username;
  return (
    <section className="section">
      <div className="section-head"><h2>{t('Benutzer')}</h2><button className="btn btn-primary" onClick={() => setCreating(true)}>{t('Benutzer anlegen')}</button></div>
      <ErrorBox error={invite.error ?? reset.error ?? toggle.error ?? remove.error} />
      {q.isLoading ? <Loading /> : (
        <table className="table">
          <thead><tr><th>{t('Name')}</th><th>{t('Anmeldung')}</th><th>{t('Rolle')}</th><th>{t('Status')}</th><th /></tr></thead>
          <tbody>
            {(q.data ?? []).map((u) => (
              <tr key={u.id}>
                <td><strong>{label(u)}</strong></td><td className="muted">{u.email ?? u.username}</td><td>{u.role}</td>
                <td><Tag kind={u.status === 'active' ? 'neutral' : 'outline'}>{t(USER_STATUS[u.status] ?? u.status)}</Tag></td>
                <td className="row gap wrap">
                  {u.status === 'invited' && <button className="btn btn-ghost" onClick={() => invite.mutate(u.id)}>{t('Einladungslink')}</button>}
                  {u.status !== 'invited' && <button className="btn btn-ghost" onClick={() => reset.mutate(u.id)}>{t('Passwort-Link')}</button>}
                  {me?.role === 'admin' && u.role !== 'staff' && <button className="btn btn-ghost" onClick={() => setAccessFor(u)}>{t('Hotels')}</button>}
                  {u.id !== me?.id && <button className="btn btn-ghost" onClick={() => toggle.mutate(u)}>{u.status === 'disabled' ? t('Aktivieren') : t('Sperren')}</button>}
                  {u.id !== me?.id && <button className="btn btn-ghost" onClick={() => remove.mutate(u.id)}>{t('Löschen')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && <CreateUser employees={emps ?? []} hotelId={hotelId} admin={me?.role === 'admin'} onClose={() => setCreating(false)} onCreated={(u, url) => { setCreating(false); refresh(); if (url) setLink({ title: t('Einladungslink'), url: url.inviteUrl, expiresAt: url.expiresAt }); void u; }} />}
      {accessFor && <HotelAccess user={accessFor} hotels={hotels} onClose={() => setAccessFor(null)} onSaved={() => { setAccessFor(null); refresh(); }} />}
      {link && (
        <Dialog title={link.title} onClose={() => setLink(null)} actions={<button className="btn btn-primary" onClick={() => setLink(null)}>{t('Fertig')}</button>}>
          <input className="input" readOnly aria-label={t('Link')} value={link.url} onFocus={(e) => e.target.select()} />
          <p className="muted small">{t('Wird nur einmal angezeigt. Gültig bis {d}.', { d: new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(link.expiresAt)) })}</p>
        </Dialog>
      )}
    </section>
  );
}

function CreateUser({ employees, hotelId, admin, onClose, onCreated }: { employees: any[]; hotelId: number; admin: boolean; onClose: () => void; onCreated: (u: any, link?: any) => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ role: 'staff', login: '', employeeId: '', firstName: '', lastName: '' });
  const email = f.login.includes('@');
  const create = useMutation({
    mutationFn: async () => {
      const u = await post('/users', {
        role: f.role, ...(email ? { email: f.login } : { username: f.login }), ...(f.employeeId ? { employeeId: Number(f.employeeId) } : {}),
        ...(f.role !== 'staff' ? { hotelIds: [hotelId] } : {}), ...(f.firstName ? { firstName: f.firstName } : {}), ...(f.lastName ? { lastName: f.lastName } : {}), deliver: 'link',
      });
      const link = await post(`/users/${u.id}/invite`, { deliver: 'link' }).catch(() => undefined);
      return { u, link };
    },
    onSuccess: ({ u, link }) => onCreated(u, link),
  });
  return (
    <Dialog title={t('Benutzer anlegen')} onClose={onClose}
      actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button><button className="btn btn-primary" form="newuser" disabled={create.isPending || !f.login}>{t('Anlegen & Link erzeugen')}</button></>}>
      <form id="newuser" className="stack" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Field label={t('E-Mail oder Benutzername')}>{(i) => <input id={i} className="input" required value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} />}</Field>
        <Field label={t('Rolle')}>{(i) => <select id={i} className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="staff">{t('Mitarbeiter')}</option>{admin && <><option value="manager">{t('Leitung')}</option><option value="admin">{t('Administration')}</option></>}</select>}</Field>
        {f.role === 'staff' && <Field label={t('Gehört zu Mitarbeiter')}>{(i) => <select id={i} className="input" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">{t('– wählen –')}</option>{employees.map((x) => <option key={x.id} value={x.id}>{x.firstName} {x.lastName}</option>)}</select>}</Field>}
        {f.role !== 'staff' && <div className="row gap wrap"><Field label={t('Vorname')}>{(i) => <input id={i} className="input" value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} />}</Field><Field label={t('Nachname')}>{(i) => <input id={i} className="input" value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} />}</Field></div>}
        <p className="muted small">{t('Die Person legt ihr Passwort selbst über den Link fest.')}</p>
        <ErrorBox error={create.error} />
      </form>
    </Dialog>
  );
}

function HotelAccess({ user, hotels, onClose, onSaved }: { user: any; hotels: { id: number; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [sel, setSel] = useState<number[]>(user.hotelIds ?? []);
  const save = useMutation({ mutationFn: () => put(`/users/${user.id}/hotel-access`, { hotelIds: sel }), onSuccess: onSaved });
  return (
    <Dialog title={t('Hotelzugang')} onClose={onClose}
      actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{t('Speichern')}</button></>}>
      <div className="stack">
        {hotels.map((h) => <label key={h.id} className="check"><input type="checkbox" checked={sel.includes(h.id)} onChange={() => setSel(sel.includes(h.id) ? sel.filter((x) => x !== h.id) : [...sel, h.id])} /> {h.name}</label>)}
        <ErrorBox error={save.error} />
      </div>
    </Dialog>
  );
}

function Blackouts({ hotelId }: { hotelId: number }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const year = Number(todayLocal().slice(0, 4));
  const q = useQuery({ queryKey: ['setup', 'blackouts', hotelId], queryFn: () => Promise.all([year, year + 1].map((y) => get('/leave-blackouts', { hotelId, year: y }).then((r) => r.data as any[]))).then((x) => x.flat()) });
  const [f, setF] = useState({ startDate: todayLocal(), endDate: todayLocal(), reason: '', mode: 'warn' });
  const create = useMutation({ mutationFn: () => post('/leave-blackouts', { hotelId, ...f }), onSuccess: () => { setF({ ...f, reason: '' }); qc.invalidateQueries({ queryKey: ['setup', 'blackouts'] }); } });
  const remove = useMutation({ mutationFn: (id: number) => del(`/leave-blackouts/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['setup', 'blackouts'] }) });
  return (
    <section className="section">
      <div className="section-head"><h2>{t('Urlaubssperren')}</h2></div>
      <p className="muted small">{t('Zeiträume (z. B. Messewochen), in denen Urlaubsanträge gewarnt oder gesperrt werden.')}</p>
      <form className="row gap wrap filters" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Field label={t('Von')}>{(i) => <input id={i} className="input" type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} />}</Field>
        <Field label={t('Bis')}>{(i) => <input id={i} className="input" type="date" required min={f.startDate} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />}</Field>
        <Field label={t('Grund')}>{(i) => <input id={i} className="input" required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
        <Field label={t('Wirkung')}>{(i) => <select id={i} className="input" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="warn">{t('Warnen')}</option><option value="block">{t('Sperren')}</option></select>}</Field>
        <button className="btn btn-primary">{t('Hinzufügen')}</button>
      </form>
      <ErrorBox error={create.error ?? remove.error} />
      {q.isLoading ? <Loading /> : (q.data ?? []).length === 0 ? <Empty>{t('Keine Sperren.')}</Empty> : (
        <table className="table"><tbody>
          {q.data!.map((b) => <tr key={b.id}><td>{b.startDate} – {b.endDate}</td><td>{b.reason}</td><td><Tag kind={b.mode === 'block' ? 'accent' : 'outline'}>{b.mode === 'block' ? t('Sperren') : t('Warnen')}</Tag></td><td><button className="btn btn-ghost" onClick={() => remove.mutate(b.id)}>{t('Löschen')}</button></td></tr>)}
        </tbody></table>
      )}
      <span hidden>{lang}</span>
    </section>
  );
}

function Audit({ hotelId }: { hotelId: number }) {
  const { t, lang } = useI18n();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const q = useQuery({ queryKey: ['setup', 'audit', hotelId, page, action], queryFn: () => get('/audit-logs', { hotelId, page, limit: 25, action: action || undefined }) });
  const total = q.data?.meta?.total ?? 0;
  return (
    <section className="section">
      <div className="section-head"><h2>{t('Protokoll')}</h2></div>
      <div className="row gap wrap filters">
        <Field label={t('Aktion (genau, z. B. shift.create)')}>{(i) => <input id={i} className="input" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} />}</Field>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <table className="table">
          <thead><tr><th>{t('Zeit')}</th><th>{t('Aktion')}</th><th>{t('Objekt')}</th><th>{t('Benutzer')}</th></tr></thead>
          <tbody>{q.data.data.map((a: any) => <tr key={a.id}><td className="small">{new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(a.createdAt))}</td><td>{a.action}</td><td className="muted">{a.entityType} #{a.entityId}</td><td className="muted">#{a.userId ?? '–'}</td></tr>)}</tbody>
        </table>
      )}
      <div className="row gap">
        <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
        <span className="muted small">{t('Seite {p} von {n}', { p: page, n: Math.max(1, Math.ceil(total / 25)) })}</span>
        <button className="btn btn-secondary" disabled={page * 25 >= total} onClick={() => setPage(page + 1)}>›</button>
      </div>
    </section>
  );
}
