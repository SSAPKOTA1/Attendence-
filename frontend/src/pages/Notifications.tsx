import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Empty, ErrorBox, Loading, Tag } from '../components/ui';

const TEXT: Record<string, string> = {
  roster_published: 'Neuer Dienstplan veröffentlicht', roster_entry_changed: 'Dein Dienst am {date} wurde geändert', roster_entry_removed: 'Dein Dienst am {date} wurde entfernt',
  absence_decided: 'Dein Abwesenheitsantrag wurde entschieden', wish_decided: 'Dein Wunsch wurde entschieden', correction_decided: 'Deine Zeitkorrektur wurde entschieden',
  inquiry_reply: 'Antwort auf deine Frage', inquiry_new: 'Neue Frage von einem Mitarbeitenden', absence_requested: 'Neuer Abwesenheitsantrag', wish_submitted: 'Neuer Wunsch',
  correction_requested: 'Neue Zeitkorrektur zur Prüfung', needs_review_entry: 'Zeiteintrag braucht Prüfung', sick_reported: 'Krankmeldung eingegangen',
  time_approval_requested: 'Arbeitszeit wartet auf Freigabe', time_approval_decided: 'Deine ungeplante Arbeitszeit wurde entschieden',
};

export default function Notifications() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications', 'list'], queryFn: () => get('/notifications', { limit: 50 }) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['notifications'] }); };
  const read = useMutation({ mutationFn: (id: number) => patch(`/notifications/${id}`, { read: true }), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: () => post('/notifications/read-all'), onSuccess: refresh });
  return (
    <div className="page">
      <header className="page-head">
        <div><div className="kicker">{t('{n} ungelesen', { n: q.data?.meta?.unread ?? 0 })}</div><h1>{t('Mitteilungen')}</h1></div>
        <button className="btn btn-secondary" onClick={() => readAll.mutate()} disabled={!q.data?.meta?.unread}>{t('Alle als gelesen markieren')}</button>
      </header>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : q.data.data.length === 0 ? <Empty>{t('Keine Mitteilungen.')}</Empty> : (
        <ul className="plain notes">
          {q.data.data.map((n: any) => (
            <li key={n.id} className={n.readAt ? 'note' : 'note unread'}>
              <div className="row gap">
                {n.urgent && <Tag kind="accent">{t('Kurzfristig')}</Tag>}
                <strong>{t(TEXT[n.kind] ?? n.kind, { date: n.params?.date ?? '' })}</strong>
              </div>
              <div className="row gap">
                <span className="muted small">{new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(n.createdAt))}</span>
                {!n.readAt && <button className="btn btn-ghost" onClick={() => read.mutate(n.id)}>{t('Gelesen')}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
