import { useEffect, useRef, useState } from 'react';
import type { CreateVoiceSessionRequest } from '@svs/shared';
import { api } from '../lib/api';
import { events } from '../lib/events';
import { VoiceSession } from './VoiceSession';

type Step = { kind: 'checking' } | { kind: 'privacy' } | { kind: 'mic' } | { kind: 'denied'; reason: MicProblem; permanent: boolean } | { kind: 'session'; stream: MediaStream };
type MicProblem = 'denied' | 'blocked' | 'busy' | 'no_mic' | 'unsupported';

const PROBLEM_TEXT: Record<MicProblem, { title: string; body: string }> = {
  denied: { title: 'Microphone is off', body: 'Voice practice needs your microphone so you can answer out loud.' },
  blocked: { title: 'Microphone is blocked', body: 'Voice practice needs your microphone so you can answer out loud. It is blocked for this site.' },
  busy: { title: 'Your mic is in use', body: 'Another app is using your microphone. Close it, then try again.' },
  no_mic: { title: 'No microphone found', body: 'Connect a microphone or headset, then try again.' },
  unsupported: { title: "Voice isn't available here", body: 'This browser or connection does not allow microphone access. Use Chrome over https (or localhost).' },
};

const howToAllow = () =>
  /Android/i.test(navigator.userAgent)
    ? 'Tap the 🔒 icon next to the address → Permissions (or Site settings) → Microphone → Allow. Then try again.'
    : 'Click the 🔒 icon next to the address → Site settings → Microphone → Allow. Then try again.';

/**
 * C3 Voice Onboarding (FR-6, FR-7; design-spec §3–4): first-use privacy notice, mic permission only after the tap,
 * a clear denied state with "Back to text" (never a dead end), then the session (C4).
 */
export function VoiceFlow({ request: initial, onClose }: { request: CreateVoiceSessionRequest; onClose: (reloadConversation: boolean) => void }) {
  const [step, setStep] = useState<Step>({ kind: 'checking' });
  // Practice again / Next activity (C5) start a new session in place: new request, fresh mic stream, new VoiceSession.
  const [request, setRequest] = useState(initial);
  const [run, setRun] = useState(0);
  const tapAt = useRef(performance.now());
  const dialogRef = useRef<HTMLDivElement>(null);
  // Ties onboarding events to the card (and so to its intent / language / arm) when the flow started from one (P6.1).
  const fields = { intent_type: request.intent, props: { entry_point: request.entry_point, ...(request.suggestion_id ? { suggestion_id: request.suggestion_id } : {}) } };

  useEffect(() => {
    api
      .getVoicePrefs()
      .then((p) => {
        if (p.privacy_notice_seen) setStep({ kind: 'mic' });
        else {
          events.log('privacy_notice_shown', fields);
          setStep({ kind: 'privacy' });
        }
      })
      .catch(() => setStep({ kind: 'privacy' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (step.kind === 'mic') void requestMic();
    dialogRef.current?.querySelector<HTMLElement>('button, a')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && step.kind !== 'session' && onClose(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [step.kind, onClose]);

  const acceptPrivacy = async () => {
    events.log('privacy_notice_ack', fields);
    await api.ackPrivacyNotice().catch(() => {});
    setStep({ kind: 'mic' });
  };

  const requestMic = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext || typeof MediaRecorder === 'undefined') {
      setStep({ kind: 'denied', reason: 'unsupported', permanent: true });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      tapAt.current = performance.now();
      events.log('mic_permission_granted', fields);
      setStep({ kind: 'session', stream });
    } catch (err) {
      const name = (err as DOMException).name;
      let permanent = false;
      try {
        permanent = (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state === 'denied';
      } catch {
        /* Permissions API not available */
      }
      const reason: MicProblem = name === 'NotFoundError' ? 'no_mic' : name === 'NotReadableError' ? 'busy' : permanent ? 'blocked' : 'denied';
      events.log('mic_permission_denied', { ...fields, props: { ...fields.props, permanent, reason } });
      setStep({ kind: 'denied', reason, permanent });
    }
  };

  if (step.kind === 'session')
    return (
      <VoiceSession
        key={run}
        request={request}
        stream={step.stream}
        requestedAt={tapAt.current}
        onClose={onClose}
        onRestart={(next) => {
          setRequest(next);
          setRun((r) => r + 1);
          setStep({ kind: 'mic' });
        }}
      />
    );

  return (
    <div className="modal-backdrop" onClick={() => onClose(false)}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="voice-onb-title" onClick={(e) => e.stopPropagation()}>
        {step.kind === 'checking' || step.kind === 'mic' ? (
          <>
            <h2 id="voice-onb-title">Starting voice practice…</h2>
            <p className="muted">{step.kind === 'mic' ? 'Allow microphone access when your browser asks.' : 'One moment.'}</p>
            <button type="button" className="btn-link" onClick={() => onClose(false)}>
              Back to text
            </button>
          </>
        ) : step.kind === 'privacy' ? (
          <>
            <h2 id="voice-onb-title">Before you start</h2>
            <p>
              Your voice is turned into text to run this practice. We don't keep the recording. Transcripts are handled under our voice privacy policy.
            </p>
            <p>
              <a href="/privacy#voice" target="_blank" rel="noreferrer">
                Privacy policy ↗
              </a>
            </p>
            <p className="muted small">Draft wording, pending Legal / Trust &amp; Safety approval (docs/phase0/legal-review.md).</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => onClose(false)}>
                Not now
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void acceptPrivacy()}>
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="voice-onb-title">🎙 {PROBLEM_TEXT[step.reason].title}</h2>
            <p>{PROBLEM_TEXT[step.reason].body}</p>
            {(step.reason === 'denied' || step.reason === 'blocked') && <p className="muted">To allow it: {howToAllow()}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => onClose(false)}>
                Back to text
              </button>
              {step.reason !== 'unsupported' && (
                <button type="button" className="btn btn-primary" onClick={() => void requestMic()}>
                  Try again
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
