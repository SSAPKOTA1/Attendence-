import { useEffect, useId, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { useT } from '../lib/i18n';

export const Tag = ({ kind = 'neutral', children, title }: { kind?: 'neutral' | 'accent' | 'accent-2' | 'outline'; children: ReactNode; title?: string }) => (
  <span className={`tag tag-${kind}`} title={title}>{children}</span>
);

export function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

export function Loading() {
  const t = useT();
  return <div className="muted pad" role="status">{t('Lädt …')}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="muted pad empty">{children}</div>;
}

/** Shows an API error (message + per-field details); renders nothing without an error. */
export function ErrorBox({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  const e = error as ApiError;
  const details = Array.isArray(e.details) ? e.details : [];
  return (
    <div className="error-box" role="alert">
      <strong>{e.message || t('Etwas ist schiefgelaufen.')}</strong>
      {details.length > 0 && (
        <ul>
          {details.slice(0, 6).map((d: any, i: number) => (
            <li key={i}>{[d.field ?? d.rule, d.issue ?? d.message ?? (d.limit !== undefined ? `${d.actual} / ${d.limit}` : '')].filter(Boolean).join(': ')}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Dialog({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-content">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Warnings({ items }: { items?: { type: string; message?: string; severity?: string }[] }) {
  if (!items?.length) return null;
  return (
    <ul className="warnings">
      {items.map((w, i) => <li key={i} className={w.severity === 'error' ? 'is-error' : ''}>{w.message ?? w.type}</li>)}
    </ul>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn' }) {
  return (
    <div className={`stat ${tone === 'warn' ? 'stat-warn' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head"><h2>{title}</h2>{aside}</div>
      {children}
    </section>
  );
}
