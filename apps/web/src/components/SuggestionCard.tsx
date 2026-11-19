import { useEffect, useRef, useState } from 'react';
import { useFeatures } from '../lib/features';
import { VoicePreview } from './VoicePreview';
import type { EntryPoint, SuggestionCardPayload } from '@svs/shared';
import { api } from '../lib/api';
import { events } from '../lib/events';

export type CardStatus = 'shown' | 'tapped';
type View = 'visible' | 'undo' | 'starting' | 'tapped' | 'gone';

const UNDO_MS = 4000;
const SHOWN_AFTER_MS = 1000;

/**
 * C2 Smart Voice Suggestion card (FR-2, FR-4; design-spec §2).
 * - `suggestion_shown` fires once, after the card is ≥50% visible for ≥1 s (edge-case UI-04)
 * - dismiss (×) has a 4 s undo; the dismissal only counts when the undo window ends
 * - "Don't suggest voice" opts out at once (reversible in Settings)
 * - Try Voice Practice records the tap and opens the voice session (FR-3); a tapped card offers Practice again
 */
export function SuggestionCard({
  card,
  status,
  onOptedOut,
  onStartVoice,
}: {
  card: SuggestionCardPayload;
  status: CardStatus;
  onOptedOut: () => void;
  onStartVoice: (card: SuggestionCardPayload, entryPoint: EntryPoint) => void;
}) {
  const [view, setView] = useState<View>(status === 'tapped' ? 'tapped' : 'visible');
  const ref = useRef<HTMLElement>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingDismiss = useRef(false);
  /** suggestion_shown fired for this card (by the visibility timer or, for a fast tap, by the tap itself). */
  const shownLogged = useRef(false);
  const fields = { intent_type: card.intent };

  // Visibility tracking for suggestion_shown.
  useEffect(() => {
    const el = ref.current;
    if (!el || status !== 'shown' || typeof IntersectionObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (shownLogged.current) return;
        if (entry?.isIntersecting) {
          timer = setTimeout(() => {
            shownLogged.current = true;
            events.log('suggestion_shown', { ...fields, props: { suggestion_id: card.suggestion_id } });
            io.disconnect();
          }, SHOWN_AFTER_MS);
        } else clearTimeout(timer);
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => {
      clearTimeout(timer);
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.suggestion_id, status]);

  const commitDismiss = (keepalive = false) => {
    if (!pendingDismiss.current) return;
    pendingDismiss.current = false;
    void api
      .dismissSuggestion(card.suggestion_id, keepalive)
      .then((r) => events.log('suggestion_dismissed', { ...fields, props: { suggestion_id: card.suggestion_id, consecutive_count: r.consecutive_dismissals ?? null, paused: r.paused ?? false } }))
      .catch(() => {});
  };

  // If the user leaves during the undo window, the dismissal still counts.
  useEffect(
    () => () => {
      clearTimeout(undoTimer.current);
      commitDismiss(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const dismiss = () => {
    pendingDismiss.current = true;
    setView('undo');
    undoTimer.current = setTimeout(() => {
      commitDismiss();
      setView('gone');
    }, UNDO_MS);
  };
  const undo = () => {
    pendingDismiss.current = false;
    clearTimeout(undoTimer.current);
    setView('visible');
  };
  const [previewOpen, setPreviewOpen] = useState(false);
  const features = useFeatures();
  const tap = async (entryPoint: EntryPoint = 'suggestion_card') => {
    // A tap proves the card was seen: log `shown` first if the visibility timer hasn't yet, so the funnel never
    // records more taps than impressions (found in the Phase 11 walkthrough).
    if (!shownLogged.current && status === 'shown') {
      shownLogged.current = true;
      events.log('suggestion_shown', { ...fields, props: { suggestion_id: card.suggestion_id } });
    }
    setView('starting');
    try {
      await api.tapSuggestion(card.suggestion_id);
      events.log('suggestion_tapped', { ...fields, props: { suggestion_id: card.suggestion_id } });
    } catch {
      /* the tap is still shown to the learner; the server copy may be missing */
    }
    setView('tapped');
    onStartVoice(card, entryPoint);
  };
  const optOut = async () => {
    setView('gone');
    try {
      await api.putVoicePrefs({ suggestions_enabled: false, suggestion_id: card.suggestion_id });
      events.log('suggestions_opted_out', { ...fields, props: { source: 'card', suggestion_id: card.suggestion_id } });
      onOptedOut();
    } catch {
      setView('visible');
    }
  };

  if (view === 'gone') return null;
  if (view === 'undo')
    return (
      <div className="card-undo" role="status">
        <span>Suggestion dismissed.</span>
        <button type="button" className="btn btn-small" onClick={undo}>
          Undo
        </button>
      </div>
    );
  if (view === 'tapped')
    return (
      <div className="card-tapped" role="status">
        <span>
          🎙 <strong>{card.preset_label}</strong> practised with voice
        </span>
        <button type="button" className="btn btn-small" onClick={() => onStartVoice(card, 'practice_again')}>
          Practice again
        </button>
      </div>
    );

  return (
    <section ref={ref} className="suggestion-card" aria-label="Voice practice suggestion" lang={card.language !== 'en' ? card.language : undefined}>
      <div className="card-head">
        <h2 className="card-title">
          <span aria-hidden="true">🎙 </span>
          {card.copy.title}
        </h2>
        <button type="button" className="icon-btn card-dismiss" aria-label={card.copy.dismiss_label} onClick={dismiss}>
          ✕
        </button>
      </div>
      <p className="card-why">{card.copy.why_line}</p>
      <p className="card-hint muted small">
        <span aria-hidden="true">🎧 </span>
        {card.copy.headphone_hint}
      </p>
      <div className="card-actions">
        <button type="button" className="btn btn-primary card-cta" onClick={() => void tap('suggestion_card')} disabled={view === 'starting'}>
          {view === 'starting' ? 'Starting…' : card.copy.cta}
        </button>
        {features.preview_mode && (
          <button type="button" className="btn card-preview" onClick={() => setPreviewOpen(true)} disabled={view === 'starting'}>
            <span aria-hidden="true">▶ </span>Hear a 30-sec preview
          </button>
        )}
        <button type="button" className="btn-link" onClick={() => void optOut()}>
          {card.copy.opt_out_label}
        </button>
      </div>
      {previewOpen && (
        <VoicePreview
          card={card}
          onClose={() => setPreviewOpen(false)}
          onStart={() => {
            setPreviewOpen(false);
            void tap('preview');
          }}
        />
      )}
    </section>
  );
}
