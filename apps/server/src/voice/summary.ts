import { z } from 'zod';
import type { ClassifierLanguage, SessionSummary, SvsConfig, VoiceIntent } from '@svs/shared';
import type { Db } from '../db';
import type { LlmGateway } from '../llm/gateway';
import { PRESETS, type Preset } from './presets';
import { VoiceError } from './orchestrator';

/**
 * S10 Summary & Coaching (FR-8, FR-9; architecture §6.5; implementation-plan P5.1–P5.4).
 * Built once per session and cached in `session_summaries`; the build starts in the background when the session ends,
 * and GET waits for it (or builds it). The tip is one Groq call (gpt-oss-120b, strict json_schema, 8 s budget,
 * fallback gpt-oss-20b); if both fail, the summary is shown without a tip (SU-04).
 */
export const SUMMARY_PROMPT_VERSION = 'summary-v1';

const ENCOURAGEMENT: Record<string, string> = {
  en: "Nice start! Next time, try answering at least one question out loud. You'll get a tip on how you did.",
  hinglish: 'Achchi shuruaat! Agli baar kam se kam ek sawal ka jawab bol kar dijiye, phir aapko ek tip milega.',
  hi: 'अच्छी शुरुआत! अगली बार कम से कम एक सवाल का जवाब बोलकर दीजिए, फिर आपको एक सुझाव मिलेगा।',
  // Phase 10 drafts (native review pending, like the regional card copy).
  bn: 'ভালো শুরু! পরের বার অন্তত একটি প্রশ্নের উত্তর জোরে বলে দিন, তাহলে আপনি একটি পরামর্শ পাবেন।',
  mr: 'छान सुरुवात! पुढच्या वेळी किमान एका प्रश्नाचे उत्तर मोठ्याने बोलून द्या, म्हणजे तुम्हाला एक टीप मिळेल.',
  te: 'మంచి ప్రారంభం! తదుపరిసారి కనీసం ఒక ప్రశ్నకు గట్టిగా సమాధానం చెప్పండి, అప్పుడు మీకు ఒక సూచన వస్తుంది.',
};

const LANGUAGE_INSTRUCTION: Record<string, string> = {
  en: 'Write the tip in simple English.',
  hinglish: 'Write the tip in Hinglish (Hindi words in Latin script mixed with English), using Latin script only.',
  hi: 'Write the tip in Hindi using Devanagari script.',
  bn: 'Write the tip in Bengali using Bengali script.',
  mr: 'Write the tip in Marathi using Devanagari script.',
  te: 'Write the tip in Telugu using Telugu script.',
};

const TipSchema = (nActivities: number) =>
  z.object({
    tip: z.string().trim().min(5).max(300),
    next_activity_index: z.number().int().min(0).max(nActivities - 1),
  });

interface SessionRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  preset_id: string;
  status: string;
  duration_s: number | null;
  questions_practised: number;
  user_turns: number;
  dominant_language: ClassifierLanguage | null;
  qualifies_for_wavl: boolean;
  streak_after: number | null;
  streak_credited: boolean;
  focus: string | null;
}

interface SummaryRow {
  tip: string | null;
  tip_source: string | null;
  next_activity_index: number | null;
  language: ClassifierLanguage | null;
  recap_message_id: string | null;
}

const presetById = (id: string): Preset => Object.values(PRESETS).find((p) => p.id === id) ?? PRESETS.mock_interview;

export class VoiceSummaries {
  private readonly inflight = new Map<string, Promise<SessionSummary>>();

  constructor(
    private readonly deps: {
      db: Db;
      gateway: LlmGateway | null;
      getConfig: () => SvsConfig;
      log?: { warn: (o: object, m: string) => void };
    },
  ) {}

  /** Build (or return) the summary. Owner-only; the session must have ended. */
  get(sessionId: string, userId: string): Promise<SessionSummary> {
    const key = sessionId;
    const existing = this.inflight.get(key);
    if (existing) return existing.then((s) => this.assertOwner(sessionId, userId).then(() => s));
    const p = this.build(sessionId, userId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Background warm-up after the session ends (errors are logged, never thrown). */
  warm(sessionId: string, userId: string) {
    void this.get(sessionId, userId).catch((err: unknown) => this.deps.log?.warn({ err: (err as Error).message }, 'summary warm-up failed'));
  }

  private async assertOwner(sessionId: string, userId: string) {
    const r = await this.deps.db.query('SELECT 1 FROM voice_sessions WHERE id = $1 AND user_id = $2', [sessionId, userId]);
    if (!r.rows[0]) throw new VoiceError(404, 'not_found');
  }

  private async loadSession(sessionId: string, userId: string): Promise<SessionRow> {
    const { rows } = await this.deps.db.query<SessionRow>(
      `SELECT id, user_id, conversation_id, preset_id, status, duration_s, questions_practised, user_turns, dominant_language,
              qualifies_for_wavl, streak_after, streak_credited, focus
       FROM voice_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    const s = rows[0];
    if (!s) throw new VoiceError(404, 'not_found');
    if (s.status !== 'ended') throw new VoiceError(409, 'session_active');
    return s;
  }

  private async build(sessionId: string, userId: string): Promise<SessionSummary> {
    const cfg = this.deps.getConfig();
    const s = await this.loadSession(sessionId, userId);
    const preset = presetById(s.preset_id);
    const language: ClassifierLanguage = s.dominant_language && s.dominant_language !== 'other' ? s.dominant_language : 'en';

    const cached = (
      await this.deps.db.query<SummaryRow>('SELECT tip, tip_source, next_activity_index, language, recap_message_id FROM session_summaries WHERE session_id = $1', [sessionId])
    ).rows[0];
    let tip: string | null = cached?.tip ?? null;
    let nextIndex = cached?.next_activity_index ?? 0;
    if (!cached) {
      let source: 'llm' | 'none' | 'failed' = 'none';
      if (s.user_turns > 0 && s.questions_practised > 0 && this.deps.gateway) {
        const generated = await this.generateTip(s, preset, language);
        if (generated) {
          tip = generated.tip;
          nextIndex = generated.next_activity_index;
          source = 'llm';
        } else source = 'failed';
      }
      await this.deps.db.query(
        `INSERT INTO session_summaries (session_id, duration_s, questions_practised, tip, next_activity, next_activity_index, streak_after, language, tip_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (session_id) DO NOTHING`,
        [sessionId, s.duration_s ?? 0, s.questions_practised, tip, preset.nextActivities[nextIndex], nextIndex, s.streak_after, language, source],
      );
    }

    return {
      session_id: s.id,
      preset_id: preset.id,
      label: preset.label,
      intent: preset.intent as VoiceIntent,
      duration_s: s.duration_s ?? 0,
      questions_practised: s.questions_practised,
      short_session: (s.duration_s ?? 0) < cfg.voice.wavlMinSessionS,
      qualifies_for_wavl: s.qualifies_for_wavl,
      tip,
      encouragement: s.questions_practised === 0 ? (ENCOURAGEMENT[language] ?? ENCOURAGEMENT.en!) : null,
      language,
      next_activity: { index: nextIndex, label: preset.nextActivities[nextIndex] ?? preset.nextActivities[0]! },
      streak: { current: s.streak_after ?? 0, goal: cfg.streak.goalDays, credited: s.streak_credited },
    };
  }

  private async generateTip(s: SessionRow, preset: Preset, language: ClassifierLanguage): Promise<{ tip: string; next_activity_index: number } | null> {
    const turns = (
      await this.deps.db.query<{ role: string; transcript: string }>('SELECT role, transcript FROM voice_turns WHERE session_id = $1 ORDER BY at, id', [s.id])
    ).rows.slice(-20);
    const transcript = turns.map((t) => `${t.role === 'user' ? 'Learner' : 'Coach'}: ${t.transcript.slice(0, 500)}`).join('\n');
    const activities = preset.nextActivities.map((a, i) => `${i}: ${a}`).join('\n');
    const schema = {
      name: 'session_summary',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['tip', 'next_activity_index'],
        properties: { tip: { type: 'string' }, next_activity_index: { type: 'integer' } },
      },
    };
    try {
      const res = await this.deps.gateway!.complete(
        'summary',
        {
          messages: [
            {
              role: 'system',
              content: [
                `You review a learner's ${preset.label} voice session and write exactly ONE actionable improvement tip (max 30 words) based on what the learner actually said: content, structure, clarity, confidence or grammar.`,
                'The tip must be specific to their answers, start with a verb, and be kind. Never repeat personal details from the transcript (names, phone numbers, emails, addresses, ID numbers).',
                LANGUAGE_INSTRUCTION[language] ?? LANGUAGE_INSTRUCTION.en,
                `Also pick the most useful next activity by its index:\n${activities}`,
                'Return JSON only.',
              ].join('\n'),
            },
            { role: 'user', content: `Transcript (speech-to-text, may contain errors):\n${transcript}` },
          ],
          maxTokens: 400,
          temperature: 0.3,
          jsonSchema: schema,
        },
        { userId: s.user_id, voiceSessionId: s.id },
      );
      return TipSchema(preset.nextActivities.length).parse(JSON.parse(res.content));
    } catch (err) {
      this.deps.log?.warn({ err: (err as Error).message, sessionId: s.id }, 'summary tip unavailable; showing summary without a tip');
      return null;
    }
  }

  /**
   * "Back to Chat" (decisions.md ADR-008: append a short recap). Idempotent: one recap message per session.
   */
  async recap(sessionId: string, userId: string): Promise<{ conversation_id: string | null; message_id: string | null }> {
    const summary = await this.get(sessionId, userId);
    const s = await this.loadSession(sessionId, userId);
    if (!s.conversation_id) return { conversation_id: null, message_id: null };
    return this.deps.db.tx(async (c) => {
      const row = await c.query<{ recap_message_id: string | null }>('SELECT recap_message_id FROM session_summaries WHERE session_id = $1 FOR UPDATE', [sessionId]);
      if (row.rows[0]?.recap_message_id) return { conversation_id: s.conversation_id, message_id: row.rows[0].recap_message_id };
      const mins = Math.floor(summary.duration_s / 60);
      const secs = String(summary.duration_s % 60).padStart(2, '0');
      const lines = [
        `**🎙 ${summary.label}**: ${mins}:${secs} practised · ${summary.questions_practised} question${summary.questions_practised === 1 ? '' : 's'} answered`,
        summary.tip ? `💡 **Tip:** ${summary.tip}` : summary.encouragement ? `💬 ${summary.encouragement}` : '',
        summary.streak.current > 0 ? `🔥 **Streak:** ${summary.streak.current} of ${summary.streak.goal} days` : '',
        `➡️ Next time: ${summary.next_activity.label}`,
      ].filter(Boolean);
      const m = await c.query<{ id: string }>("INSERT INTO messages (conversation_id, role, content, status, model) VALUES ($1, 'assistant', $2, 'complete', 'voice-recap') RETURNING id", [
        s.conversation_id,
        lines.join('\n\n'),
      ]);
      await c.query('UPDATE session_summaries SET recap_message_id = $2 WHERE session_id = $1', [sessionId, m.rows[0]!.id]);
      await c.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [s.conversation_id]);
      return { conversation_id: s.conversation_id, message_id: m.rows[0]!.id };
    });
  }
}
