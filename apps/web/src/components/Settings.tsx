import { useEffect, useRef, useState } from 'react';
import type { VoicePreferences } from '@svs/shared';
import { api } from '../lib/api';
import { events } from '../lib/events';

/** C6 Settings (FR-4, FR-10; design-spec §7): voice suggestions on/off, plus voice speed and voice. */
export function Settings({
  onClose,
  research,
}: {
  onClose: () => void;
  /** Dogfood participants only: the research-consent setting (P8.2). */
  research?: { value: 'granted' | 'declined' | null; onChange: (granted: boolean) => void };
}) {
  const [prefs, setPrefs] = useState<VoicePreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(document.activeElement);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Runs once per open: load prefs, close on Escape, return focus to the opener on close.
  useEffect(() => {
    api.getVoicePrefs().then(setPrefs, () => setError("Couldn't load your settings."));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      (returnFocus.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (prefs) firstRef.current?.focus();
  }, [prefs]);

  const save = async (patch: Partial<Pick<VoicePreferences, 'suggestions_enabled' | 'voice_speed' | 'voice_accent'>>) => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.putVoicePrefs(patch);
      setPrefs(next);
      if (patch.suggestions_enabled !== undefined) {
        events.log(patch.suggestions_enabled ? 'suggestions_opted_in' : 'suggestions_opted_out', { props: { source: 'settings' } });
      }
      if (patch.voice_speed || patch.voice_accent) {
        events.log('voice_setting_changed', { props: { setting: patch.voice_speed ? 'speed' : 'accent', value: patch.voice_speed ?? patch.voice_accent ?? null } });
      }
    } catch {
      setError("Couldn't save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const enabled = prefs?.suggestions_enabled ?? false;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-btn" aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </div>
        {!prefs && !error && <p className="muted">Loading…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {prefs && (
          <>
            <div className="setting-row">
              <div>
                <p className="setting-label" id="sugg-label">
                  Voice suggestions
                </p>
                <p className="muted small">Show a voice practice option when it could help.</p>
                {enabled && prefs.paused_until && (
                  <p className="muted small">Paused until {new Date(prefs.paused_until).toLocaleDateString()} after several dismissals.</p>
                )}
              </div>
              <button
                ref={firstRef}
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-labelledby="sugg-label"
                className={`switch ${enabled ? 'on' : ''}`}
                disabled={saving}
                onClick={() => void save({ suggestions_enabled: !enabled })}
              >
                <span className="switch-text">{enabled ? 'On' : 'Off'}</span>
              </button>
            </div>
            {research && (
              <div className="setting-row">
                <div>
                  <p className="setting-label" id="research-label">
                    Help improve suggestions
                  </p>
                  <p className="muted small">Test group only: let the team read the questions you type, to check when voice should be suggested.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={research.value === 'granted'}
                  aria-labelledby="research-label"
                  className={`switch ${research.value === 'granted' ? 'on' : ''}`}
                  onClick={() => research.onChange(research.value !== 'granted')}
                >
                  <span className="switch-text">{research.value === 'granted' ? 'On' : 'Off'}</span>
                </button>
              </div>
            )}
            <div className="setting-row">
              <label className="setting-label" htmlFor="voice-speed">
                Voice speed
              </label>
              <select id="voice-speed" className="input select" value={prefs.voice_speed} disabled={saving} onChange={(e) => void save({ voice_speed: e.target.value as VoicePreferences['voice_speed'] })}>
                <option value="slow">Slower (0.8×)</option>
                <option value="normal">Normal (1×)</option>
                <option value="fast">Faster (1.2×)</option>
              </select>
            </div>
            <div className="setting-row">
              <label className="setting-label" htmlFor="voice-accent">
                Voice
              </label>
              <select id="voice-accent" className="input select" value={prefs.voice_accent} disabled={saving} onChange={(e) => void save({ voice_accent: e.target.value as VoicePreferences['voice_accent'] })}>
                <option value="en-IN">English (India)</option>
                <option value="hi-IN">Hindi</option>
              </select>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
