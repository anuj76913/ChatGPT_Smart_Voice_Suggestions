import { useEffect, useRef } from 'react';
import { PRESET_BY_INTENT, VOICE_INTENTS, type VoiceIntent } from '@svs/shared';

const WHAT: Record<VoiceIntent, string> = {
  mock_interview: 'Answer interview questions out loud and get feedback',
  spoken_english: 'Have a relaxed conversation in English',
  viva_revision: 'Get quizzed out loud on what you are studying',
  pronunciation: 'Practise saying tricky words clearly',
};

/**
 * Phase 8 (BB-15): the general mic button's practice picker. Voice without a card (entry_point = mic_button), so the
 * baseline pre-period and the control arm can measure organic voice use.
 */
export function PracticePicker({ onPick, onClose }: { onPick: (intent: VoiceIntent) => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="picker-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="picker-title">Practise speaking</h2>
        <p className="muted">Pick what you want to practise. The coach speaks first.</p>
        <ul className="picker">
          {VOICE_INTENTS.map((intent) => (
            <li key={intent}>
              <button type="button" className="btn picker-option" onClick={() => onPick(intent)}>
                <strong>{PRESET_BY_INTENT[intent].label}</strong>
                <span className="muted small">{WHAT[intent]}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
