import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreateVoiceSessionRequest, CreateVoiceSessionResponse, VoiceServerMessage, VoiceSessionStats, VoiceSettings } from '@svs/shared';
import { api } from '../lib/api';
import { events } from '../lib/events';
import { TurnRecorder } from '../lib/voice/recorder';
import { SessionSummaryPanel, type SummaryAction } from './SessionSummaryPanel';
import { hasHindiVoice, loadVoices, Speaker } from '../lib/voice/tts';

type Phase = 'starting' | 'speaking' | 'listening' | 'thinking' | 'paused' | 'reconnecting' | 'lost' | 'ended' | 'failed';
interface Caption {
  key: string;
  role: 'user' | 'assistant';
  text: string;
}

const PHASE_LABEL: Record<Phase, string> = {
  starting: 'Starting…',
  speaking: 'Speaking',
  listening: 'Listening… speak now',
  thinking: 'Thinking',
  paused: 'Paused',
  reconnecting: 'Reconnecting…',
  lost: 'Connection lost',
  ended: 'Session ended',
  failed: "Couldn't start",
};

/**
 * C4 Voice Session UI (FR-3, FR-10; design-spec §5; architecture §6.8).
 * The assistant speaks first; captions are always shown; the mic is closed while the assistant speaks (no echo);
 * end of turn = 1.2 s of silence or "Done"; reconnects for 5 s, then offers "Continue in text".
 * When the session ends it shows the summary (C5) with Practice again / Next activity / Back to chat.
 */
export function VoiceSession({
  request,
  stream,
  requestedAt,
  onClose,
  onRestart,
}: {
  request: CreateVoiceSessionRequest;
  stream: MediaStream;
  requestedAt: number;
  onClose: (reloadConversation: boolean) => void;
  /** Start a fresh session from the summary (Practice again / Next activity). */
  onRestart: (next: CreateVoiceSessionRequest) => void;
}) {
  const [session, setSession] = useState<CreateVoiceSessionResponse | null>(null);
  const [phase, setPhase] = useState<Phase>('starting');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [noisy, setNoisy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [stats, setStats] = useState<VoiceSessionStats | null>(null);
  const [settings, setSettings] = useState<VoiceSettings>({ speed: 'normal', accent: 'en-IN' });
  const [showSettings, setShowSettings] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [level, setLevel] = useState(0);

  const ws = useRef<WebSocket | null>(null);
  // Handlers run from socket/timer callbacks created on earlier renders, so they read refs, never render state.
  const sessionRef = useRef<CreateVoiceSessionResponse | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const recorder = useRef<TurnRecorder | null>(null);
  const phaseRef = useRef<Phase>('starting');
  const lastTurnId = useRef<string | null>(null);
  const replyKey = useRef<string | null>(null);
  const startedAt = useRef(Date.now());
  const closing = useRef(false);
  const silenceTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const captionsEnd = useRef<HTMLDivElement>(null);
  /** The live mic stream: starts as the one VoiceFlow got, replaced if the mic drops and is re-acquired. */
  const streamRef = useRef(stream);
  const releaseMic = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const makeRecorder = (s: CreateVoiceSessionResponse, mic: MediaStream, quiet: boolean) => {
    const r = new TurnRecorder(mic, { silenceMs: s.limits.end_of_speech_silence_ms, maxMs: s.limits.max_turn_s * 1000, onLevel: setLevel });
    r.quiet = quiet;
    return r;
  };

  /** The mic stopped (unplugged, Bluetooth switch, another app took it): ask the browser for it again. */
  const reacquireMic = async (s: CreateVoiceSessionResponse): Promise<TurnRecorder> => {
    const fresh = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const quiet = recorder.current?.quiet ?? false;
    recorder.current?.dispose();
    streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = fresh;
    recorder.current = makeRecorder(s, fresh, quiet);
    return recorder.current;
  };

  const setP = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };
  const clearSilence = () => silenceTimers.current.splice(0).forEach(clearTimeout);
  const sendJson = (m: object) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(m));
  const fields = { intent_type: request.intent };
  /** In-session events carry the session id so the server can tag intent, language and arm (P6.1). */
  const sid = () => sessionRef.current?.session_id ?? '';

  const listen = useCallback(async () => {
    const s = sessionRef.current;
    if (!recorder.current || !s || ['paused', 'ended', 'lost', 'reconnecting', 'failed'].includes(phaseRef.current)) return;
    setP('listening');
    clearSilence();
    silenceTimers.current.push(setTimeout(() => setNotice("Take your time. Tap Done when you've finished."), s.limits.silence_nudge_ms));
    silenceTimers.current.push(
      setTimeout(() => {
        recorder.current?.cancel();
        sendJson({ type: 'pause' });
        setNotice('Paused because it was quiet for a while.');
        setP('paused');
      }, s.limits.silence_pause_ms),
    );
    let turn: Awaited<ReturnType<TurnRecorder['start']>>;
    try {
      turn = await recorder.current.start();
    } catch (first) {
      // Bug bash (BB-02): MediaRecorder can throw (mic unplugged, revoked, busy). Try to get the mic back once;
      // if that fails too, pause with a clear message rather than staying on "Listening" forever.
      console.warn('[voice] recording failed, re-acquiring the microphone:', first);
      try {
        turn = await (await reacquireMic(s)).start();
      } catch (err) {
        console.warn('[voice] microphone unavailable:', err);
        clearSilence();
        const name = (err as { name?: string })?.name;
        setNotice(
          name === 'NotAllowedError'
            ? 'Microphone access was turned off. Allow it from the 🔒 icon in the address bar, then tap Resume.'
            : name === 'NotFoundError'
              ? 'No microphone found. Plug one in, then tap Resume.'
              : name === 'NotReadableError'
                ? 'Another app is using your microphone. Close it, then tap Resume.'
                : 'Your microphone stopped working. Check it, then tap Resume.',
        );
        setP('paused');
        return;
      }
    }
    clearSilence();
    if (!turn || phaseRef.current !== 'listening') return;
    if (!turn.hadSpeech) {
      setNotice("I didn't hear anything. Try again, a little closer to the mic.");
      void listen();
      return;
    }
    setNotice(null);
    setP('thinking');
    sendJson({ type: 'turn', mime: turn.mime });
    ws.current?.send(await turn.blob.arrayBuffer());
  }, []);

  const afterSpeech = useCallback(async () => {
    // settled(), not idle(): the mic must not open while the coach is still audible, or it records the coach.
    await speaker.current?.settled();
    if (phaseRef.current === 'speaking') void listen();
  }, [listen]);

  const onServer = useCallback(
    (m: VoiceServerMessage) => {
      switch (m.type) {
        case 'ready':
          if (m.missed.length) setCaptions((c) => [...c, ...m.missed.map((x) => ({ key: x.turn_id, role: x.role, text: x.text }))]);
          if (phaseRef.current === 'reconnecting') {
            events.log('voice_session_network_drop', { ...fields, props: { voice_session_id: sid(), resumed: true, continued_in_text: false } });
            void listen();
          }
          return;
        case 'transcript.final':
          lastTurnId.current = m.turn_id;
          setCaptions((c) => [...c, { key: m.turn_id, role: 'user', text: m.text }]);
          setP('thinking');
          return;
        case 'transcript.echo':
          // The mic heard the coach; nothing the learner said was lost. Listen again quietly.
          void listen();
          return;
        case 'transcript.empty':
          setNotice("I didn't catch that. Please try again.");
          void listen();
          return;
        case 'reply.sentence': {
          if (!replyKey.current) {
            replyKey.current = `r-${Date.now()}`;
            const key = replyKey.current;
            setCaptions((c) => [...c, { key, role: 'assistant', text: m.text }]);
          } else {
            const key = replyKey.current;
            setCaptions((c) => c.map((x) => (x.key === key ? { ...x, text: `${x.text} ${m.text}` } : x)));
          }
          setP('speaking');
          void speaker.current?.speak(m.text);
          return;
        }
        case 'reply.done':
          lastTurnId.current = m.turn_id;
          replyKey.current = null;
          void afterSpeech();
          return;
        case 'hint.noisy_room':
          setNoisy(true);
          events.log('noisy_room_hint_shown', { ...fields, props: { voice_session_id: sid() } });
          return;
        case 'limit.warning':
          setWarning(`${Math.max(1, Math.round(m.seconds_left / 60))} minute left`);
          return;
        case 'error':
          setNotice(m.code === 'stt_failed' ? "Couldn't hear that clearly. Please try again." : m.code === 'audio_too_large' ? 'That answer was too long. Try a shorter one.' : m.code === 'too_many_turns' ? 'Slow down a little: take a moment before your next answer.' : 'Something went wrong. Please try again.');
          if (phaseRef.current === 'thinking') void listen();
          return;
        case 'session.ended':
          closing.current = true;
          clearSilence();
          recorder.current?.cancel();
          setStats(m.stats);
          void speaker.current?.idle().then(() => setP('ended'));
          return;
        default:
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listen, afterSpeech],
  );

  const connect = useCallback(
    (s: CreateVoiceSessionResponse, attempt = 0): void => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const last = lastTurnId.current ? `&last_turn_id=${lastTurnId.current}` : '';
      const sock = new WebSocket(`${proto}://${location.host}${s.stream.path}?token=${encodeURIComponent(s.stream.token)}${last}`);
      sock.binaryType = 'arraybuffer';
      ws.current = sock;
      sock.onmessage = (e) => onServer(JSON.parse(String(e.data)) as VoiceServerMessage);
      sock.onclose = (e) => {
        if (closing.current || e.code === 1000 || e.code === 4404 || e.code === 4401) {
          if (!closing.current && e.code !== 1000) setP('lost');
          return;
        }
        // Network drop (PRD-4): retry for `reconnect_ms`, then offer to continue in text.
        recorder.current?.cancel();
        if (attempt * 1000 >= s.limits.reconnect_ms) {
          setP('lost');
          events.log('voice_session_network_drop', { ...fields, props: { voice_session_id: s.session_id, resumed: false, continued_in_text: false } });
          return;
        }
        setP('reconnecting');
        setTimeout(() => connect(s, attempt + 1), 1000);
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onServer],
  );

  // Create the session, open the stream, and let the assistant speak first (FR-3).
  useEffect(() => {
    let cancelled = false;
    recorder.current = null;
    (async () => {
      try {
        await loadVoices();
        const s = await api.createVoiceSession(request);
        if (cancelled) return;
        startedAt.current = Date.now();
        setSettings(s.settings);
        speaker.current = new Speaker(s.settings, () => {
          // Start latency: session request → first audible assistant audio (NFR < 2 s).
          const ms = Math.round(performance.now() - requestedAt);
          sendJson({ type: 'metrics', start_latency_ms: ms });
        });
        recorder.current = makeRecorder(s, streamRef.current, !!s.settings.quiet);
        sessionRef.current = s;
        setSession(s);
        lastTurnId.current = null;
        setCaptions([{ key: 'opening', role: 'assistant', text: s.opening.text }]);
        connect(s);
        setP('speaking');
        await speaker.current.speak(s.opening.text);
        await speaker.current.settled();
        if (!cancelled && phaseRef.current === 'speaking') void listen();
      } catch {
        if (!cancelled) setP('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab hidden → pause (edge-case DV-02); the learner resumes explicitly.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden' && ['listening', 'speaking', 'thinking'].includes(phaseRef.current)) {
        recorder.current?.cancel();
        speaker.current?.cancel();
        sendJson({ type: 'pause' });
        setP('paused');
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Cleanup: mic off, socket closed, speech stopped.
  // The mic is released one tick later, and only if the component did not mount again: React StrictMode (dev)
  // mounts → unmounts → mounts every component, and stopping the tracks on that fake unmount killed the mic
  // before the first turn ("Your microphone stopped working" on every session in `npm run demo`).
  useEffect(() => {
    closing.current = false;
    if (releaseMic.current) clearTimeout(releaseMic.current);
    releaseMic.current = undefined;
    return () => {
      closing.current = true;
      clearSilence();
      recorder.current?.dispose();
      speaker.current?.cancel();
      ws.current?.close(1000);
      releaseMic.current = setTimeout(() => streamRef.current.getTracks().forEach((t) => t.stop()), 0);
    };
  }, [stream]);

  // Block body on purpose: in current Chrome scrollIntoView() returns a Promise, and an effect must return
  // nothing or a cleanup function (returning the Promise crashed the session screen: bug bash P7.8, BB-01).
  useEffect(() => {
    captionsEnd.current?.scrollIntoView({ block: 'end' });
  }, [captions]);

  const resume = () => {
    sendJson({ type: 'resume' });
    setNotice(null);
    setP('listening');
    void listen();
  };

  const end = async () => {
    setConfirmEnd(false);
    recorder.current?.cancel();
    speaker.current?.cancel();
    clearSilence();
    if (ws.current?.readyState === WebSocket.OPEN) sendJson({ type: 'end' });
    else if (session) {
      closing.current = true;
      setStats(await api.endVoiceSession(session.session_id).catch(() => null));
      setP('ended');
    }
  };
  const requestEnd = () => ((Date.now() - startedAt.current) / 1000 < 30 && phaseRef.current !== 'lost' ? setConfirmEnd(true) : void end());

  const continueInText = async () => {
    if (!session) return;
    closing.current = true;
    await api.continueInText(session.session_id).catch(() => null);
    events.log('voice_session_network_drop', { ...fields, props: { voice_session_id: session.session_id, resumed: false, continued_in_text: true } });
    onClose(true);
  };

  const changeSettings = (patch: Partial<VoiceSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    speaker.current?.setSettings(next);
    if (recorder.current) recorder.current.quiet = !!next.quiet;
    sendJson({ type: 'settings', ...patch });
    const setting = patch.speed ? 'speed' : patch.accent ? 'accent' : 'quiet';
    const value = patch.speed ?? patch.accent ?? (patch.quiet === undefined ? null : patch.quiet ? 'on' : 'off');
    events.log('voice_setting_changed', { ...fields, props: { setting, value, ...(sessionRef.current ? { voice_session_id: sid() } : {}) } });
  };

  const onSummaryAction = async (action: SummaryAction, summary: { next_activity: { index: number } } | null) => {
    if (!session) return;
    events.log('summary_action', { ...fields, props: { action, voice_session_id: session.session_id } });
    const base = { intent: request.intent, ...(request.conversation_id ? { conversation_id: request.conversation_id } : {}) };
    if (action === 'practice_again') onRestart({ ...base, entry_point: 'practice_again' });
    else if (action === 'next_activity' && summary) onRestart({ ...base, entry_point: 'next_activity', next_activity_index: summary.next_activity.index });
    else {
      // Back to chat leaves a short recap in the conversation (idempotent on the server).
      await api.recapVoiceSession(session.session_id).catch(() => null);
      onClose(true);
    }
  };

  const label = session?.label ?? 'Voice practice';
  return (
    <div className="voice-backdrop">
      <section className="voice" role="dialog" aria-modal="true" aria-label={`${label} voice session`}>
        <header className="voice-head">
          <button type="button" className="btn btn-small" onClick={requestEnd} disabled={phase === 'ended' || phase === 'failed'}>
            ✕ End
          </button>
          <h2 className="voice-title">{label}</h2>
          <button type="button" className="btn btn-small" aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)}>
            ⚙ Speed / Voice
          </button>
        </header>

        {showSettings && phase !== 'ended' && (
          <div className="voice-settings">
            <label>
              Speed{' '}
              <select className="input select" value={settings.speed} onChange={(e) => changeSettings({ speed: e.target.value as VoiceSettings['speed'] })}>
                <option value="slow">Slower</option>
                <option value="normal">Normal</option>
                <option value="fast">Faster</option>
              </select>
            </label>
            <label>
              Voice{' '}
              <select className="input select" value={settings.accent} onChange={(e) => changeSettings({ accent: e.target.value as VoiceSettings['accent'] })}>
                <option value="en-IN">English (India)</option>
                <option value="hi-IN">Hindi{hasHindiVoice() ? '' : ' (not on this device)'}</option>
              </select>
            </label>
            {settings.quiet !== undefined && (
              <div className="quiet-toggle">
                <span id="quiet-label">Quiet mode: speak softly (library, hostel)</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.quiet}
                  aria-labelledby="quiet-label"
                  className={`switch ${settings.quiet ? 'on' : ''}`}
                  onClick={() => changeSettings({ quiet: !settings.quiet })}
                >
                  <span className="switch-text">{settings.quiet ? 'On' : 'Off'}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {phase === 'ended' && session ? (
          <SessionSummaryPanel sessionId={session.session_id} stats={stats} onAction={(a, sum) => void onSummaryAction(a, sum)} />
        ) : (
        <div className="voice-captions" aria-live="polite">
          {captions.map((c) => (
            <p key={c.key} className={`caption caption-${c.role}`}>
              <span className="sr-only">{c.role === 'user' ? 'You said: ' : 'Coach: '}</span>
              {c.role === 'user' && <span aria-hidden="true">You: </span>}
              {c.text}
            </p>
          ))}
          <div ref={captionsEnd} />
        </div>
        )}

        <div className="voice-status" role="status" hidden={phase === 'ended' && !!session}>
          <span className={`dot dot-${phase}`} aria-hidden="true" style={phase === 'listening' ? { transform: `scale(${1 + Math.min(level * 12, 0.8)})` } : undefined} />
          <strong>{PHASE_LABEL[phase]}</strong>
          {warning && phase !== 'ended' && <span className="pill">{warning}</span>}
        </div>
        {noisy && phase !== 'ended' && <p className="voice-hint">ⓘ Noisy room? Try headphones or move somewhere quieter.</p>}
        {settings.quiet && phase !== 'ended' && <p className="voice-hint">🤫 Quiet mode is on: speak softly, and use headphones to hear the coach.</p>}
        {notice && phase !== 'ended' && <p className="voice-hint">{notice}</p>}
        {!notice && phase === 'listening' && <p className="voice-hint">Take your time. Pause for about 2 seconds, or tap Done speaking, when you've finished.</p>}

        {confirmEnd && (
          <div className="voice-confirm" role="alertdialog" aria-label="End now?">
            <p>End now? Short sessions (under 30 seconds) don't count toward your streak.</p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setConfirmEnd(false)}>
                Keep practising
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void end()}>
                End now
              </button>
            </div>
          </div>
        )}

        <footer className="voice-controls" hidden={phase === 'ended' && !!session}>
          {phase === 'listening' && (
            <button type="button" className="btn btn-primary" onClick={() => recorder.current?.stop()}>
              ✓ Done speaking
            </button>
          )}
          {phase === 'paused' && (
            <button type="button" className="btn btn-primary" onClick={resume}>
              Resume
            </button>
          )}
          {phase === 'lost' && (
            <>
              <button type="button" className="btn btn-primary" onClick={() => void continueInText()}>
                Continue in text
              </button>
              <button type="button" className="btn" onClick={() => void end()}>
                End session
              </button>
            </>
          )}
          {phase === 'failed' && (
            <button type="button" className="btn btn-primary" onClick={() => onClose(false)}>
              Back to chat
            </button>
          )}
          {phase === 'ended' && !session && (
            <button type="button" className="btn btn-primary" onClick={() => onClose(true)}>
              Back to chat
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
