import { useEffect, useRef, useState } from 'react';
import type { FeedbackReportRequest } from '@svs/shared';
import { api } from '../lib/api';

/**
 * P8.3 "Report a problem" for dogfood participants. Free text is stored only because the participant typed it
 * here and sent it; the triage team reads it, and it's deleted after privacy.feedbackRetentionDays.
 */
export function ReportProblem({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [kind, setKind] = useState<FeedbackReportRequest['kind']>('bug');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    dialogRef.current?.querySelector<HTMLElement>('select')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendFeedback({ kind, text: text.trim(), screen: 'chat' });
      onSent();
    } catch {
      setError("Couldn't send it. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="report-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="report-title">Report a problem</h2>
        <p className="muted small">Thanks for testing. The team reads every report during daily triage. Don't include passwords or personal details.</p>
        <form
          className="report-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label>
            Type{' '}
            <select className="input select" value={kind} onChange={(e) => setKind(e.target.value as FeedbackReportRequest['kind'])}>
              <option value="bug">Something is broken</option>
              <option value="idea">An idea or suggestion</option>
              <option value="other">Something else</option>
            </select>
          </label>
          <label className="report-text">
            What happened?
            <textarea className="input" rows={5} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <span className="muted small" aria-live="polite">
            {text.length}/1000
          </span>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
