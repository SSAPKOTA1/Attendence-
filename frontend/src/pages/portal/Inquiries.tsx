import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post } from '../../lib/api';
import { isManager, useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { Dialog, Empty, ErrorBox, Field, Loading, Tag } from '../../components/ui';

const CATEGORY: Record<string, string> = { roster: 'Dienstplan', hours: 'Stunden', vacation: 'Urlaub', attendance: 'Zeiterfassung', other: 'Sonstiges' };
const STATUS: Record<string, string> = { open: 'Offen', answered: 'Beantwortet', closed: 'Geschlossen' };

/** Employees ask questions; managers use the same page to answer the ones routed to their hotels. */
export default function Inquiries() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['inquiries'], queryFn: () => get('/inquiries', { limit: 50 }).then((r) => r.data) });
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState('other');
  const [body, setBody] = useState('');
  const create = useMutation({
    mutationFn: () => post('/inquiries', { subject, category, body }),
    onSuccess: (r) => { setCreating(false); setSubject(''); setBody(''); qc.invalidateQueries({ queryKey: ['inquiries'] }); setOpenId(r.id); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  return (
    <div className="page">
      <header className="page-head">
        <div><div className="kicker">{isManager(user) ? t('An deine Hotels gerichtet') : t('Deine Leitung antwortet hier')}</div><h1>{t('Fragen')}</h1></div>
        {user?.employeeId && <button className="btn btn-primary" onClick={() => setCreating(true)}>{t('Neue Frage')}</button>}
      </header>
      {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : (list.data ?? []).length === 0 ? <Empty>{t('Keine Fragen.')}</Empty> : (
        <table className="table">
          <tbody>
            {list.data.map((i: any) => (
              <tr key={i.id} className="clickable" onClick={() => setOpenId(i.id)}>
                <td><button className="linklike" onClick={() => setOpenId(i.id)}>{i.subject}</button></td>
                <td className="muted">{t(CATEGORY[i.category] ?? i.category)}</td>
                <td className="muted">{i.employee?.displayName}</td>
                <td><Tag kind={i.status === 'answered' ? 'accent' : 'neutral'}>{t(STATUS[i.status] ?? i.status)}</Tag></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && (
        <Dialog title={t('Frage an die Leitung')} onClose={() => setCreating(false)}
          actions={<><button className="btn btn-secondary" onClick={() => setCreating(false)}>{t('Abbrechen')}</button><button className="btn btn-primary" form="inq" disabled={create.isPending}>{t('Frage senden')}</button></>}>
          <form id="inq" className="stack" onSubmit={submit}>
            <p className="muted small">{t('Bitte schreibe hier keine Gesundheitsdaten. Antworten sehen nur du und die Leitung deines Hotels.')}</p>
            <Field label={t('Betreff')}>{(i) => <input id={i} className="input" required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
            <Field label={t('Thema')}>{(i) => <select id={i} className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</select>}</Field>
            <Field label={t('Nachricht')}>{(i) => <textarea id={i} className="input" required rows={5} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
            <ErrorBox error={create.error} />
          </form>
        </Dialog>
      )}
      {openId !== null && <Thread id={openId} lang={lang} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function Thread({ id, onClose, lang }: { id: number; onClose: () => void; lang: string }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['inquiry', id], queryFn: () => get(`/inquiries/${id}`) });
  const [text, setText] = useState('');
  const reply = useMutation({ mutationFn: () => post(`/inquiries/${id}/messages`, { body: text }), onSuccess: () => { setText(''); qc.invalidateQueries({ queryKey: ['inquiry', id] }); qc.invalidateQueries({ queryKey: ['inquiries'] }); } });
  const setStatus = useMutation({ mutationFn: (status: string) => patch(`/inquiries/${id}`, { status }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['inquiry', id] }); qc.invalidateQueries({ queryKey: ['inquiries'] }); } });
  const d = q.data;
  return (
    <Dialog title={d?.subject ?? '…'} onClose={onClose}
      actions={d && <><button className="btn btn-secondary" onClick={() => setStatus.mutate(d.status === 'closed' ? 'open' : 'closed')}>{d.status === 'closed' ? t('Wieder öffnen') : t('Schließen')}</button><button className="btn btn-primary" onClick={onClose}>{t('Fertig')}</button></>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="stack">
          <ul className="plain thread">
            {d.messages.map((m: any) => (
              <li key={m.id} className={m.author?.role === 'staff' ? 'msg' : 'msg msg-mgr'}>
                <div className="muted small">{m.author?.displayName} · {new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(m.createdAt))}</div>
                <div>{m.body}</div>
              </li>
            ))}
          </ul>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (text.trim()) reply.mutate(); }}>
            <textarea className="input" aria-label={t('Antwort')} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={user?.role === 'staff' ? t('Nachricht …') : t('Antwort …')} />
            <ErrorBox error={reply.error} />
            <button className="btn btn-primary self-start" disabled={!text.trim() || reply.isPending}>{t('Senden')}</button>
          </form>
        </div>
      )}
    </Dialog>
  );
}
