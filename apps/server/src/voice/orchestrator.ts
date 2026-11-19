import {
  type ClassifierLanguage,
  type CreateVoiceSessionRequest,
  type CreateVoiceSessionResponse,
  type SvsConfig,
  type VoiceClientMessage,
  type VoiceEndReason,
  type VoiceServerMessage,
  type VoiceSessionStats,
  type VoiceSettings,
} from '@svs/shared';
import type { AuthUser } from '../auth';
import { scriptInstruction } from '../chat/prompts';
import { detectLanguage } from '../classifier/language';
import type { Db } from '../db';
import { EventStore } from '../events/store';
import type { LlmGateway, LlmMessage } from '../llm/gateway';
import { COACH_PROMPT_VERSION, COACH_RULES, openingTemplate, PRESETS, type Preset } from './presets';
import type { SpeechGateway } from './speech';
import { creditDay, localDay, visibleStreak, type StreakState } from './streak';
import { isCoachEcho } from './echo';
import { signStreamToken } from './token';

/**
 * S8 Voice Session Orchestrator (architecture §6.4, §6.8; implementation-plan P4.4–P4.9).
 * One live session per user, held in memory (single server instance for the MVP) and mirrored in Postgres.
 * Turn loop: audio clip → Whisper (S9) → transcript.final → coach (Groq, streamed) → reply.sentence* → reply.done.
 * Audio is never stored; only finalized transcripts (as the Voice Mode policy allows).
 */

export interface VoiceSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export class VoiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  language: ClassifierLanguage | null;
}

interface Live {
  id: string;
  user: AuthUser;
  conversationId: string | null;
  preset: Preset;
  /** FR-9: the next activity this session focuses on, if started from a summary. */
  focus: string | null;
  startedAt: number;
  pausedMs: number;
  pauseStart: number | null;
  gapMs: number;
  disconnectedAt: number | null;
  chatContext: string;
  turns: Turn[];
  langTally: Map<ClassifierLanguage, number>;
  /** Language of the opening line; tags session events when the learner never spoke (P6.1). */
  openingLanguage: ClassifierLanguage;
  lastLanguage: ClassifierLanguage | null;
  questions: number;
  userTurns: number;
  lowStreak: number;
  lastAssistantQuestion: boolean;
  busy: boolean;
  /** Start times of recent turns, for the per-session turn rate limit (P7.4). */
  turnTimes: number[];
  sttFailures: number;
  coachFailures: number;
  pendingMime: string;
  socket: VoiceSocket | null;
  timers: { warn?: ReturnType<typeof setTimeout>; cap?: ReturnType<typeof setTimeout>; resume?: ReturnType<typeof setTimeout> };
  settings: VoiceSettings;
  startLatencyMs: number | null;
  ended: VoiceSessionStats | null;
}

export interface OrchestratorDeps {
  db: Db;
  gateway: LlmGateway | null;
  speech: SpeechGateway | null;
  getConfig: () => SvsConfig;
  secret: string;
  log?: { warn: (o: object, m: string) => void };
  /** Called after a session ends (e.g. to start building its summary in the background). */
  onEnded?: (sessionId: string, userId: string) => void;
}

const SORRY: Record<string, string> = {
  en: 'Sorry, can you say that again?',
  hinglish: 'Sorry, kya aap phir se bol sakte hain?',
  hi: 'माफ़ कीजिए, क्या आप फिर से बोल सकते हैं?',
};
const MAX_FAILURES = 3;
const SESSION_TURNS_FOR_COACH = 16;

/** Strips Markdown and URLs so text-to-speech doesn't read symbols aloud (edge-case IS-19). */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>|~]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the text ends with a question, ignoring closing quotes/brackets (e.g. `…this role?”`). */
export function isQuestion(text: string): boolean {
  return /[?？]["'”’»)\]\s]*$/.test(text.trim());
}

/** Splits streamed text into complete sentences; returns [complete sentences, remainder]. */
export function takeSentences(buffer: string): [string[], string] {
  const out: string[] = [];
  // Lazy up to sentence punctuation that is followed by whitespace, so "3.5" or "e.g.x" don't split mid-number.
  const re = /^([\s\S]*?[.!?।]+["')\]]*)\s+/;
  let rest = buffer;
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    const s = m[1]!.trim();
    if (s) out.push(s);
    rest = rest.slice(m[0].length);
  }
  return [out, rest];
}

export class VoiceOrchestrator {
  private readonly live = new Map<string, Live>();
  private readonly events: EventStore;

  constructor(private readonly deps: OrchestratorDeps) {
    this.events = new EventStore(deps.db);
  }

  get liveCount() {
    return this.live.size;
  }

  private cfg() {
    return this.deps.getConfig();
  }

  private send(l: Live, msg: VoiceServerMessage) {
    try {
      l.socket?.send(JSON.stringify(msg));
    } catch {
      /* socket already gone */
    }
  }

  // ── create ───────────────────────────────────────────────────────────────

  async create(user: AuthUser, req: CreateVoiceSessionRequest): Promise<CreateVoiceSessionResponse> {
    const cfg = this.cfg();
    const db = this.deps.db;
    const preset = PRESETS[req.intent];
    let focus: string | null = null;
    if (req.next_activity_index !== undefined) {
      focus = preset.nextActivities[req.next_activity_index] ?? null;
      if (!focus) throw new VoiceError(400, 'invalid_next_activity');
    }
    const focusLine = focus ? `Focus for this session: ${focus}.` : '';
    let conversationId = req.conversation_id ?? null;
    if (req.suggestion_id) {
      const s = await db.query<{ conversation_id: string }>('SELECT conversation_id FROM suggestions WHERE id = $1 AND user_id = $2', [req.suggestion_id, user.id]);
      if (!s.rows[0]) throw new VoiceError(404, 'suggestion_not_found');
      conversationId = s.rows[0].conversation_id;
    }
    if (conversationId) {
      const c = await db.query('SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, user.id]);
      if (!c.rows[0]) throw new VoiceError(404, 'conversation_not_found');
    }

    // One active session per user: the older one ends as superseded (edge-case VS-08).
    for (const l of this.live.values()) if (l.user.id === user.id) await this.end(l.id, 'superseded');
    await db.query("UPDATE voice_sessions SET status = 'ended', end_reason = 'superseded', ended_at = now() WHERE user_id = $1 AND status = 'active'", [user.id]);

    const history = conversationId
      ? (
          await db.query<{ role: 'user' | 'assistant'; content: string }>(
            "SELECT role, content FROM messages WHERE conversation_id = $1 AND status = 'complete' AND content <> '' ORDER BY seq DESC LIMIT $2",
            [conversationId, cfg.voice.contextTurns],
          )
        ).rows.reverse()
      : [];
    const chatContext = history.map((m) => `${m.role === 'user' ? 'Learner' : 'Assistant'}: ${m.content.slice(0, 600)}`).join('\n');
    const lastUserText = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
    const lang0 = detectLanguage(lastUserText);
    const language: ClassifierLanguage = lang0 === 'other' ? 'en' : lang0;

    const prefs = (
      await db.query<{ voice_speed: VoiceSettings['speed']; voice_accent: VoiceSettings['accent']; quiet_mode: boolean }>(
        'SELECT voice_speed, voice_accent, quiet_mode FROM voice_prefs WHERE user_id = $1',
        [user.id],
      )
    ).rows[0];
    const settings: VoiceSettings = { speed: prefs?.voice_speed ?? 'normal', accent: prefs?.voice_accent ?? (language === 'hi' ? 'hi-IN' : 'en-IN') };
    // Phase 11 quiet / whisper mode (flag v2.quietMode).
    if (cfg.v2.quietMode.enabled) settings.quiet = prefs?.quiet_mode ?? false;

    // Opening line (P4.4): Groq within the 600 ms budget, else the preset's static template, so the assistant always speaks first.
    const t0 = Date.now();
    let opening = openingTemplate(preset, language);
    let source: 'llm' | 'template' = 'template';
    if (this.deps.gateway) {
      try {
        const res = await this.deps.gateway.complete(
          'opening',
          {
            messages: [
              {
                role: 'system',
                content: `${preset.role}\n${COACH_RULES}\n${focusLine}\nTask: ${preset.opening} Reply with only what you say, in 1–2 short sentences ending with a question.\n${scriptInstruction(lastUserText || 'English')}`,
              },
              { role: 'user', content: chatContext ? `Chat before this practice:\n${chatContext}` : 'No earlier chat. Start the practice.' },
            ],
            maxTokens: 200,
            temperature: 0.7,
          },
          { userId: user.id, conversationId: conversationId ?? undefined },
        );
        const text = speakable(res.content);
        if (text.length > 0 && text.length < 400) {
          opening = text;
          source = 'llm';
        }
      } catch {
        /* template fallback */
      }
    }
    const openingMs = Date.now() - t0;

    const row = await db.query<{ id: string }>(
      `INSERT INTO voice_sessions (user_id, conversation_id, suggestion_id, preset_id, entry_point, status, started_at, opening_source, focus, intent, language)
       VALUES ($1, $2, $3, $4, $5, 'active', now(), $6, $7, $8, $9) RETURNING id`,
      [user.id, conversationId, req.suggestion_id ?? null, preset.id, req.entry_point, source, focus, preset.intent, language],
    );
    const id = row.rows[0]!.id;
    const openingTurn = await db.query<{ id: string }>(
      "INSERT INTO voice_turns (session_id, role, transcript, language) VALUES ($1, 'assistant', $2, $3) RETURNING id",
      [id, opening, language],
    );

    const l: Live = {
      id,
      user,
      conversationId,
      preset,
      focus,
      startedAt: Date.now(),
      pausedMs: 0,
      pauseStart: null,
      gapMs: 0,
      disconnectedAt: Date.now(), // counts as a gap until the socket connects
      chatContext,
      turns: [{ id: openingTurn.rows[0]!.id, role: 'assistant', text: opening, language }],
      langTally: new Map(),
      openingLanguage: language,
      lastLanguage: null,
      questions: 0,
      userTurns: 0,
      lowStreak: 0,
      lastAssistantQuestion: isQuestion(opening),
      busy: false,
      turnTimes: [],
      sttFailures: 0,
      coachFailures: 0,
      pendingMime: 'audio/webm',
      socket: null,
      timers: {},
      settings,
      startLatencyMs: null,
      ended: null,
    };
    this.live.set(id, l);
    this.scheduleCap(l);
    this.scheduleResumeTimeout(l);

    const en = await this.events.enrichment(user, cfg.experiment.id).catch(() => ({ userId: user.id, cohort: user.cohort, experimentId: null, arm: null }));
    void this.events
      .emitServer('voice_session_started', en, {
        sessionId: id,
        intentType: preset.intent,
        language,
        props: { voice_session_id: id, preset_id: preset.id, entry_point: req.entry_point, opening_source: source, opening_ms: openingMs, suggestion_id: req.suggestion_id ?? null },
      })
      .catch((err: unknown) => this.deps.log?.warn({ err: (err as Error).message }, 'failed to emit voice_session_started'));

    return {
      session_id: id,
      preset_id: preset.id,
      label: preset.label,
      opening: { text: opening, language, source },
      settings,
      stream: { path: `/v1/voice/sessions/${id}/stream`, token: signStreamToken(this.deps.secret, id, user.id) },
      limits: {
        max_duration_s: cfg.voice.maxDurationS,
        warn_before_end_s: cfg.voice.warnBeforeEndS,
        max_turn_s: cfg.voice.maxTurnSeconds,
        end_of_speech_silence_ms: cfg.voice.endOfSpeechSilenceMs,
        reconnect_ms: cfg.voice.reconnectMs,
        silence_nudge_ms: cfg.voice.silenceNudgeMs,
        silence_pause_ms: cfg.voice.silencePauseMs,
      },
    };
  }

  private scheduleCap(l: Live) {
    const cfg = this.cfg();
    const capMs = cfg.voice.maxDurationS * 1000;
    const warnMs = Math.max(0, capMs - cfg.voice.warnBeforeEndS * 1000);
    if (cfg.voice.warnBeforeEndS > 0) l.timers.warn = setTimeout(() => this.send(l, { type: 'limit.warning', seconds_left: cfg.voice.warnBeforeEndS }), warnMs);
    l.timers.cap = setTimeout(() => void this.end(l.id, 'cap'), capMs);
  }

  private scheduleResumeTimeout(l: Live) {
    clearTimeout(l.timers.resume);
    l.timers.resume = setTimeout(() => void this.end(l.id, 'network'), this.cfg().voice.serverResumeWindowMs);
  }

  // ── socket lifecycle ────────────────────────────────────────────────────

  owns(sessionId: string, userId: string): boolean {
    return this.live.get(sessionId)?.user.id === userId;
  }

  attach(sessionId: string, userId: string, socket: VoiceSocket, lastTurnId: string | null) {
    const l = this.live.get(sessionId);
    if (!l || l.user.id !== userId || l.ended) {
      socket.close(4404, 'session_not_live');
      return;
    }
    const resumed = l.socket !== null || l.turns.length > 1 || l.userTurns > 0;
    if (l.socket && l.socket !== socket) l.socket.close(4409, 'replaced');
    l.socket = socket;
    clearTimeout(l.timers.resume);
    if (l.disconnectedAt) {
      l.gapMs += Date.now() - l.disconnectedAt;
      l.disconnectedAt = null;
    }
    const idx = lastTurnId ? l.turns.findIndex((t) => t.id === lastTurnId) : -1;
    const missed = lastTurnId && idx >= 0 ? l.turns.slice(idx + 1).map((t) => ({ turn_id: t.id, role: t.role, text: t.text })) : [];
    this.send(l, { type: 'ready', session_id: l.id, resumed: resumed && !!lastTurnId, missed });
  }

  detach(sessionId: string, socket: VoiceSocket) {
    const l = this.live.get(sessionId);
    if (!l || l.socket !== socket || l.ended) return;
    l.socket = null;
    l.disconnectedAt = Date.now();
    this.scheduleResumeTimeout(l); // keeps the session resumable (edge-case NW-01) then ends it as "network"
  }

  async onMessage(sessionId: string, data: Buffer | string, isBinary: boolean) {
    const l = this.live.get(sessionId);
    if (!l || l.ended) return;
    if (isBinary) return this.onAudio(l, typeof data === 'string' ? Buffer.from(data) : data);
    let msg: VoiceClientMessage;
    try {
      msg = JSON.parse(String(data)) as VoiceClientMessage;
    } catch {
      return this.send(l, { type: 'error', code: 'bad_message' });
    }
    switch (msg.type) {
      case 'turn':
        l.pendingMime = /^audio\/[a-z0-9.+-]+(;.*)?$/i.test(msg.mime) ? msg.mime.split(';')[0]! : 'audio/webm';
        return;
      case 'settings':
        if (msg.speed) l.settings.speed = msg.speed;
        if (msg.accent) l.settings.accent = msg.accent;
        if (typeof msg.quiet === 'boolean' && this.cfg().v2.quietMode.enabled) l.settings.quiet = msg.quiet;
        await this.deps.db
          .query('UPDATE voice_prefs SET voice_speed = $2, voice_accent = $3, quiet_mode = $4, updated_at = now() WHERE user_id = $1', [
            l.user.id,
            l.settings.speed,
            l.settings.accent,
            l.settings.quiet ?? false,
          ])
          .catch(() => {});
        return;
      case 'metrics':
        if (l.startLatencyMs === null && Number.isFinite(msg.start_latency_ms) && msg.start_latency_ms >= 0 && msg.start_latency_ms < 120000) {
          l.startLatencyMs = Math.round(msg.start_latency_ms);
          await this.deps.db.query('UPDATE voice_sessions SET start_latency_ms = $2 WHERE id = $1', [l.id, l.startLatencyMs]).catch(() => {});
        }
        return;
      case 'pause':
        if (l.pauseStart === null) l.pauseStart = Date.now();
        return;
      case 'resume':
        if (l.pauseStart !== null) {
          l.pausedMs += Date.now() - l.pauseStart;
          l.pauseStart = null;
        }
        return;
      case 'end':
        await this.end(l.id, msg.reason === 'idle' ? 'idle' : 'user');
        return;
      default:
        return;
    }
  }

  // ── turn loop ───────────────────────────────────────────────────────────

  private async onAudio(l: Live, audio: Buffer) {
    const cfg = this.cfg();
    if (audio.byteLength > cfg.voice.maxTurnAudioBytes) return this.send(l, { type: 'error', code: 'audio_too_large' });
    if (l.busy) return this.send(l, { type: 'busy' });
    // Abuse guard (P7.4): every turn costs a Whisper and a coach call against the shared Groq quota.
    const now = Date.now();
    l.turnTimes = l.turnTimes.filter((t) => now - t < 60_000);
    if (l.turnTimes.length >= cfg.voice.maxTurnsPerMinute) return this.send(l, { type: 'error', code: 'too_many_turns' });
    l.turnTimes.push(now);
    if (!this.deps.speech) return this.send(l, { type: 'error', code: 'stt_failed' });
    l.busy = true;
    try {
      let t;
      try {
        t = await this.deps.speech.transcribe(new Uint8Array(audio), l.pendingMime, { userId: l.user.id, voiceSessionId: l.id });
      } catch {
        this.send(l, { type: 'error', code: 'stt_failed' });
        if (++l.sttFailures >= MAX_FAILURES) await this.end(l.id, 'error');
        return;
      }
      if (l.ended) return;
      // Quality monitor (edge-case IS-01 / PRD-2): N low-quality turns in a row → noisy-room hint.
      l.lowStreak = t.lowQuality ? l.lowStreak + 1 : 0;
      // Quiet mode: soft speech scores low on purpose, so don't call the room noisy.
      if (l.lowStreak === cfg.voice.noisyTurns && !l.settings.quiet) this.send(l, { type: 'hint.noisy_room' });
      if (!t.text) {
        this.send(l, { type: 'transcript.empty' });
        return;
      }
      // The mic heard the coach, not the learner: drop it and listen again (not a learner turn, not counted).
      const lastCoach = [...l.turns].reverse().find((x) => x.role === 'assistant')?.text;
      if (isCoachEcho(t.text, lastCoach)) {
        this.deps.log?.warn({ voiceSessionId: l.id }, 'voice turn dropped as coach echo');
        this.send(l, { type: 'transcript.echo' });
        return;
      }
      l.sttFailures = 0;
      const language = t.language === 'other' ? (l.lastLanguage ?? 'en') : t.language;
      const turn = await this.deps.db.query<{ id: string }>(
        "INSERT INTO voice_turns (session_id, role, transcript, language, stt_confidence) VALUES ($1, 'user', $2, $3, $4) RETURNING id",
        [l.id, t.text, language, t.avgLogprob === null ? null : Math.exp(t.avgLogprob)],
      );
      // Question counter (P4.7): an answer of ≥3 words to an assistant question (edge-case IS-09).
      if (l.lastAssistantQuestion && t.text.split(/\s+/).filter(Boolean).length >= 3) l.questions++;
      l.userTurns++;
      l.langTally.set(language, (l.langTally.get(language) ?? 0) + 1);
      l.lastLanguage = language;
      l.turns.push({ id: turn.rows[0]!.id, role: 'user', text: t.text, language });
      this.send(l, { type: 'transcript.final', turn_id: turn.rows[0]!.id, text: t.text, language, low_quality: t.lowQuality });
      await this.coach(l, t.text, language);
    } finally {
      l.busy = false;
    }
  }

  private async coach(l: Live, userText: string, language: ClassifierLanguage) {
    const cfg = this.cfg();
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: [
          l.preset.role,
          COACH_RULES,
          l.focus ? `Focus for this session: ${l.focus}.` : '',
          l.chatContext ? `Context from the learner's chat before this practice:\n${l.chatContext}` : '',
          scriptInstruction(userText),
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      ...l.turns.slice(-SESSION_TURNS_FOR_COACH).map((t) => ({ role: t.role, content: t.text }) as LlmMessage),
    ];
    let buffer = '';
    let full = '';
    let sent = 0;
    const emit = (s: string) => {
      const clean = speakable(s);
      if (!clean) return;
      full += (full ? ' ' : '') + clean;
      sent++;
      this.send(l, { type: 'reply.sentence', text: clean, language });
    };
    try {
      if (!this.deps.gateway) throw new Error('no gateway');
      for await (const c of this.deps.gateway.stream('coach', { messages, maxTokens: cfg.voice.coachMaxTokens, temperature: 0.7 }, { userId: l.user.id, voiceSessionId: l.id })) {
        if (l.ended) return;
        if (c.type !== 'delta') continue;
        buffer += c.text;
        const [done, rest] = takeSentences(buffer);
        buffer = rest;
        done.forEach(emit);
      }
      if (buffer.trim()) emit(buffer);
      if (sent === 0) throw new Error('empty reply');
      l.coachFailures = 0;
    } catch {
      if (buffer.trim()) emit(buffer);
      if (sent === 0) {
        // Both models failed (P4.6): ask to repeat; end after repeated failures (edge-case IS-23).
        emit(SORRY[language] ?? SORRY.en!);
        if (++l.coachFailures >= MAX_FAILURES) {
          await this.finishReply(l, full);
          await this.end(l.id, 'error');
          return;
        }
      }
    }
    await this.finishReply(l, full);
  }

  private async finishReply(l: Live, text: string) {
    if (l.ended || !text) return;
    const row = await this.deps.db.query<{ id: string }>(
      "INSERT INTO voice_turns (session_id, role, transcript, language) VALUES ($1, 'assistant', $2, $3) RETURNING id",
      [l.id, text, l.lastLanguage],
    );
    l.lastAssistantQuestion = isQuestion(text);
    l.turns.push({ id: row.rows[0]!.id, role: 'assistant', text, language: l.lastLanguage });
    this.send(l, { type: 'reply.done', turn_id: row.rows[0]!.id, text, question: l.lastAssistantQuestion });
  }

  // ── end ─────────────────────────────────────────────────────────────────

  private dominantLanguage(l: Live): ClassifierLanguage | null {
    let best: ClassifierLanguage | null = null;
    let n = 0;
    for (const [lang, c] of l.langTally) {
      if (c > n || (c === n && lang === l.lastLanguage)) {
        best = lang;
        n = c;
      }
    }
    return best;
  }

  /** Ends a session (idempotent). Works for sessions no longer in memory too (e.g. after a server restart). */
  async end(sessionId: string, reason: VoiceEndReason, userId?: string): Promise<VoiceSessionStats> {
    const l = this.live.get(sessionId);
    if (!l) return this.endOrphan(sessionId, reason, userId);
    if (userId && l.user.id !== userId) throw new VoiceError(404, 'not_found');
    if (l.ended) return l.ended;
    const now = Date.now();
    Object.values(l.timers).forEach((t) => clearTimeout(t));
    const pausedNow = l.pauseStart !== null ? now - l.pauseStart : 0;
    const gapNow = l.disconnectedAt !== null ? now - l.disconnectedAt : 0;
    const durationS = Math.max(0, Math.floor((now - l.startedAt - l.pausedMs - pausedNow - l.gapMs - gapNow) / 1000));
    const qualifies = durationS >= this.cfg().voice.wavlMinSessionS && l.userTurns > 0;
    const goal = this.cfg().streak.goalDays;
    const stats: VoiceSessionStats = {
      session_id: l.id,
      duration_s: durationS,
      questions_practised: l.questions,
      user_turns: l.userTurns,
      dominant_language: this.dominantLanguage(l),
      qualifies_for_wavl: qualifies,
      end_reason: reason,
      streak: { current: 0, goal, credited: false },
    };
    l.ended = stats;
    await this.deps.db.tx(async (c) => {
      // P5.3 streak: a qualifying session credits the local day it started (SU-07), in the user's time zone.
      const prefs = await c.query<{ streak_current: number; last_day: string | null }>(
        'SELECT streak_current, streak_last_day::text AS last_day FROM voice_prefs WHERE user_id = $1 FOR UPDATE',
        [l.user.id],
      );
      const prev: StreakState = { current: prefs.rows[0]?.streak_current ?? 0, lastDay: prefs.rows[0]?.last_day ?? null };
      const startDay = localDay(new Date(l.startedAt), l.user.timezone);
      const today = localDay(new Date(now), l.user.timezone);
      if (qualifies) {
        const next = creditDay(prev, startDay);
        await c.query(
          `INSERT INTO voice_prefs (user_id, streak_current, streak_last_day) VALUES ($1, $2, $3::date)
           ON CONFLICT (user_id) DO UPDATE SET streak_current = $2, streak_last_day = $3::date, updated_at = now()`,
          [l.user.id, next.current, next.lastDay],
        );
        stats.streak = { current: visibleStreak(next, today), goal, credited: true };
      } else {
        stats.streak = { current: visibleStreak(prev, today), goal, credited: false };
      }
      await c.query(
        `UPDATE voice_sessions SET status = 'ended', ended_at = now(), end_reason = $2, duration_s = $3, questions_practised = $4,
           user_turns = $5, dominant_language = $6, qualifies_for_wavl = $7, streak_after = $8, streak_credited = $9 WHERE id = $1`,
        [l.id, reason, durationS, l.questions, l.userTurns, stats.dominant_language, qualifies, stats.streak.current, stats.streak.credited],
      );
    });
    try {
      this.deps.onEnded?.(l.id, l.user.id);
    } catch {
      /* summary warm-up is best-effort */
    }
    const en = await this.events.enrichment(l.user, this.cfg().experiment.id).catch(() => ({ userId: l.user.id, cohort: l.user.cohort, experimentId: null, arm: null }));
    void this.events
      .emitServer('voice_session_completed', en, {
        sessionId: l.id,
        intentType: l.preset.intent,
        language: stats.dominant_language ?? l.openingLanguage,
        props: {
          voice_session_id: l.id,
          preset_id: l.preset.id,
          duration_s: durationS,
          questions: l.questions,
          user_turns: l.userTurns,
          end_reason: reason,
          dominant_language: stats.dominant_language,
          qualifies_for_wavl: stats.qualifies_for_wavl,
          start_latency_ms: l.startLatencyMs,
          coach_prompt: COACH_PROMPT_VERSION,
        },
      })
      .catch((err: unknown) => this.deps.log?.warn({ err: (err as Error).message }, 'failed to emit voice_session_completed'));
    this.send(l, { type: 'session.ended', stats });
    l.socket?.close(1000, 'ended');
    this.live.delete(l.id);
    return stats;
  }

  private async endOrphan(sessionId: string, reason: VoiceEndReason, userId?: string): Promise<VoiceSessionStats> {
    const { rows } = await this.deps.db.query<{
      id: string; user_id: string; status: string; end_reason: string | null; duration_s: number | null; questions_practised: number; user_turns: number; dominant_language: ClassifierLanguage | null; qualifies_for_wavl: boolean; secs: number;
      streak_after: number | null; streak_credited: boolean;
    }>(
      `SELECT id, user_id, status, end_reason, duration_s, questions_practised, user_turns, dominant_language, qualifies_for_wavl,
              streak_after, streak_credited,
              GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)))::int AS secs FROM voice_sessions WHERE id = $1`,
      [sessionId],
    );
    const r = rows[0];
    if (!r || (userId && r.user_id !== userId)) throw new VoiceError(404, 'not_found');
    if (r.status === 'active') {
      await this.deps.db.query("UPDATE voice_sessions SET status = 'ended', ended_at = now(), end_reason = $2 WHERE id = $1", [sessionId, reason]);
      r.end_reason = reason;
    }
    return {
      session_id: r.id,
      duration_s: r.duration_s ?? r.secs,
      questions_practised: r.questions_practised,
      user_turns: r.user_turns,
      dominant_language: r.dominant_language,
      qualifies_for_wavl: r.qualifies_for_wavl,
      end_reason: (r.end_reason ?? reason) as VoiceEndReason,
      streak: { current: r.streak_after ?? 0, goal: this.cfg().streak.goalDays, credited: r.streak_credited },
    };
  }

  /**
   * Network drop fallback (PRD edge case, P4.9): end the session and append a recap of the practice to the chat,
   * so the learner continues in text without losing context.
   */
  async continueInText(sessionId: string, userId: string): Promise<{ conversation_id: string | null; message_id: string | null; stats: VoiceSessionStats }> {
    const l = this.live.get(sessionId);
    const label = l?.preset.label ?? 'Voice practice';
    const stats = await this.end(sessionId, 'continue_in_text', userId);
    const { rows } = await this.deps.db.query<{ conversation_id: string | null }>('SELECT conversation_id FROM voice_sessions WHERE id = $1', [sessionId]);
    const conversationId = rows[0]?.conversation_id ?? null;
    if (!conversationId) return { conversation_id: null, message_id: null, stats };
    const turns = (
      await this.deps.db.query<{ role: string; transcript: string }>('SELECT role, transcript FROM voice_turns WHERE session_id = $1 ORDER BY at, id', [sessionId])
    ).rows.slice(-10);
    const recap = [
      `**🎙 ${label}: recap of your voice practice**`,
      '',
      ...turns.map((t) => `**${t.role === 'user' ? 'You' : 'Coach'}:** ${t.transcript}`),
      '',
      '_The voice session ended. You can keep going here in text._',
    ].join('\n');
    const m = await this.deps.db.query<{ id: string }>(
      "INSERT INTO messages (conversation_id, role, content, status, model) VALUES ($1, 'assistant', $2, 'complete', 'voice-recap') RETURNING id",
      [conversationId, recap],
    );
    await this.deps.db.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
    return { conversation_id: conversationId, message_id: m.rows[0]!.id, stats };
  }

  /** Server shutdown: end every live session so rows don't stay "active". */
  async shutdown() {
    for (const id of [...this.live.keys()]) await this.end(id, 'network').catch(() => {});
  }
}
