import { useEffect, useRef, useState } from 'react';
import { VOICE_PREVIEWS, type SuggestionCardPayload } from '@svs/shared';
import { events } from '../lib/events';
import { loadVoices, Speaker } from '../lib/voice/tts';

const MAX_S = 30;

/**
 * Phase 11 Voice Preview Mode (flag v2.previewMode): a ~30-second guided demo of what a voice practice turn sounds
 * like (coach question → sample answer → feedback), read aloud with captions. No microphone, no permission prompt.
 * Ends with "Start practising", which opens the real session (entry_point "preview").
 */
export function VoicePreview({ card, onClose, onStart }: { card: SuggestionCardPayload; onClose: () => void; onStart: () => void }) {
  const lines = VOICE_PREVIEWS[card.intent];
  const [shown, setShown] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState(false);
  const speaker = useRef<Speaker | null>(null);
  const started = useRef(Date.now());
  const ended = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fields = { intent_type: card.intent, props: { suggestion_id: card.suggestion_id } };

  const finish = (outcome: 'finished' | 'stopped' | 'started_practice') => {
    if (ended.current) return;
    ended.current = true;
    speaker.current?.cancel();
    events.log('voice_preview_ended', { intent_type: card.intent, props: { suggestion_id: card.suggestion_id, seconds: Math.round((Date.now() - started.current) / 1000), outcome } });
  };

  useEffect(() => {
    let cancelled = false;
    events.log('voice_preview_started', fields);
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
    (async () => {
      await loadVoices();
      speaker.current = new Speaker({ speed: 'normal', accent: 'en-IN' });
      for (let i = 0; i < lines.length && !cancelled; i++) {
        setShown(i + 1);
        // The sample answer is read a little faster, so it sounds like a different speaker.
        speaker.current.setSettings({ speed: lines[i]!.role === 'learner' ? 'fast' : 'normal', accent: 'en-IN' });
        await speaker.current.speak(lines[i]!.text);
        if (Date.now() - started.current > MAX_S * 1000) break;
      }
      if (!cancelled) {
        setDone(true);
        finish('finished');
      }
    })();
    const tick = setInterval(() => setElapsed(Math.min(MAX_S, (Date.now() - started.current) / 1000)), 250);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      clearInterval(tick);
      document.removeEventListener('keydown', onKey);
      speaker.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    finish('stopped');
    onClose();
  };
  const start = () => {
    finish('started_practice');
    onStart();
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div ref={dialogRef} className="modal preview" role="dialog" aria-modal="true" aria-labelledby="preview-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="preview-title">Preview: {card.preset_label}</h2>
        <p className="muted small">Listen to a 30-second example. No microphone needed.</p>
        <div className="preview-progress" role="progressbar" aria-label="Preview progress" aria-valuemin={0} aria-valuemax={MAX_S} aria-valuenow={Math.round(elapsed)}>
          <span style={{ width: `${(done ? 1 : elapsed / MAX_S) * 100}%` }} />
        </div>
        <ol className="preview-lines" aria-live="polite">
          {lines.slice(0, shown).map((l, i) => (
            <li key={i} className={`preview-line preview-${l.role}`}>
              <span className="preview-who">{l.role === 'coach' ? 'Coach' : 'Sample answer'}</span>
              {l.text}
            </li>
          ))}
        </ol>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>
            {done ? 'Not now' : 'Stop preview'}
          </button>
          <button type="button" className="btn btn-primary" onClick={start}>
            Start practising
          </button>
        </div>
      </div>
    </div>
  );
}
