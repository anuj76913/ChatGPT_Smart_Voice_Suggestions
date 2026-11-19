import { useEffect, useRef, useState } from 'react';
import type { SessionSummary, VoiceSessionStats } from '@svs/shared';
import { api, ApiError } from '../lib/api';

export type SummaryAction = 'practice_again' | 'next_activity' | 'back_to_chat';

/**
 * C5 Session Summary (FR-8, FR-9; design-spec §6): duration, questions practised, one tip, streak progress,
 * and three ways forward: Practice again, the next activity, or Back to chat (which leaves a short recap in the chat).
 * Duration and questions show at once from the session's own stats; the tip arrives when the server has it.
 */
export function SessionSummaryPanel({
  sessionId,
  stats,
  onAction,
}: {
  sessionId: string;
  stats: VoiceSessionStats | null;
  onAction: (action: SummaryAction, summary: SessionSummary | null) => void;
}) {
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 409 = the server hasn't finished ending the session yet (e.g. the socket closed a moment ago): retry briefly.
      for (let attempt = 0; attempt < 10 && !cancelled; attempt++) {
        try {
          const s = await api.getVoiceSummary(sessionId);
          if (!cancelled) setSummary(s);
          return;
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 409)) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!cancelled) setFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const duration = summary?.duration_s ?? stats?.duration_s ?? 0;
  const questions = summary?.questions_practised ?? stats?.questions_practised ?? 0;
  const short = summary?.short_session ?? (stats ? !stats.qualifies_for_wavl && stats.duration_s < 30 : false);
  const streak = summary?.streak ?? stats?.streak ?? null;
  const loading = !summary && !failed;
  // lang attribute for screen readers: Hindi and the regional languages (Hinglish is read as English).
  const textLang = summary && ['hi', 'bn', 'mr', 'te'].includes(summary.language) ? summary.language : undefined;

  const act = (a: SummaryAction) => {
    if (busy) return;
    setBusy(true);
    onAction(a, summary);
  };

  return (
    <div className="summary" aria-busy={loading}>
      <h3 className="summary-title" tabIndex={-1} ref={headingRef}>
        Session complete
      </h3>
      <dl className="summary-stats">
        <div>
          <dt>Time practised</dt>
          <dd>{formatDuration(duration)}</dd>
        </div>
        <div>
          <dt>Questions answered</dt>
          <dd>{questions}</dd>
        </div>
      </dl>
      {short && <p className="muted small">Short session: sessions under 30 seconds don't count toward your streak.</p>}

      <div className="summary-tip" aria-live="polite">
        {loading ? (
          <p className="muted">Preparing your tip…</p>
        ) : summary?.tip ? (
          <p lang={textLang}>
            <strong>Tip: </strong>
            {summary.tip}
          </p>
        ) : summary?.encouragement ? (
          <p lang={textLang}>{summary.encouragement}</p>
        ) : (
          <p className="muted">Nice work. Keep practising to build confidence.</p>
        )}
      </div>

      {streak && <StreakDots current={streak.current} goal={streak.goal} credited={streak.credited} />}


      <div className="summary-actions">
        {summary && (
          <button type="button" className="btn btn-primary" onClick={() => act('next_activity')} disabled={busy}>
            Next: {summary.next_activity.label}
          </button>
        )}
        <button type="button" className="btn" onClick={() => act('practice_again')} disabled={busy}>
          Practice again
        </button>
        <button type="button" className={summary ? 'btn' : 'btn btn-primary'} onClick={() => act('back_to_chat')} disabled={busy}>
          Back to chat
        </button>
      </div>
    </div>
  );
}

function StreakDots({ current, goal, credited }: { current: number; goal: number; credited: boolean }) {
  const shown = Math.min(current, goal);
  const label = current >= goal ? `${current}-day streak. Goal reached!` : `${shown} of ${goal} days`;
  return (
    <div className="streak" role="img" aria-label={`Practice streak: ${label}`}>
      <span className="streak-dots" aria-hidden="true">
        {Array.from({ length: goal }, (_, i) => (
          <span key={i} className={`streak-dot${i < shown ? ' on' : ''}`} />
        ))}
      </span>
      <span aria-hidden="true">
        {label}
        {credited ? ' · today counted' : ''}
      </span>
    </div>
  );
}

export function formatDuration(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
