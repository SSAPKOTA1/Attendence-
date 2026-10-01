import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { patch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Dialog, ErrorBox, Field } from '../../components/ui';
import { instantToLocal, localToInstant } from '../../lib/zone';

/** Manager correction of one time entry (also closes forgotten clock-outs): PATCH /attendance/:id with a reason. */
export default function CloseEntryDialog({ entryId, clockInAt, clockOutAt, breakMinutes, tz, onClose }: { entryId: number; clockInAt: string; clockOutAt?: string | null; breakMinutes?: number; tz?: string; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [inAt, setIn] = useState(instantToLocal(clockInAt, tz));
  const [out, setOut] = useState(clockOutAt ? instantToLocal(clockOutAt, tz) : `${instantToLocal(clockInAt, tz).slice(0, 10)}T`);
  const [brk, setBrk] = useState(String(breakMinutes ?? 0));
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => patch(`/attendance/${entryId}`, { clockInAt: localToInstant(inAt, tz), ...(out.length === 16 ? { clockOutAt: localToInstant(out, tz) } : {}), breakMinutes: Number(brk), reason }),
    onSuccess: () => { qc.invalidateQueries(); onClose(); },
  });
  return (
    <Dialog title={t('Zeiteintrag korrigieren')} onClose={onClose}
      actions={<><button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button><button className="btn btn-primary" disabled={save.isPending || !reason.trim()} onClick={() => save.mutate()}>{t('Speichern')}</button></>}>
      <div className="stack">
        <Field label={t('Eingestempelt')}>{(i) => <input id={i} className="input" type="datetime-local" value={inAt} onChange={(e) => setIn(e.target.value)} />}</Field>
        <Field label={t('Ausgestempelt')}>{(i) => <input id={i} className="input" type="datetime-local" value={out} onChange={(e) => setOut(e.target.value)} />}</Field>
        <Field label={t('Pause (Minuten)')}>{(i) => <input id={i} className="input" type="number" min={0} value={brk} onChange={(e) => setBrk(e.target.value)} />}</Field>
        <Field label={t('Begründung')}>{(i) => <textarea id={i} className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <ErrorBox error={save.error} />
      </div>
    </Dialog>
  );
}
