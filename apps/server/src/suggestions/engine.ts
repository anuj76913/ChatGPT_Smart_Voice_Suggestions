import { cardIntent, copyLanguageFor, suggestionCard, type Arm, type ClassifierResult, type SuggestionCardPayload, type SvsConfig, type VoiceIntent } from '@svs/shared';
import type { AuthUser } from '../auth';
import type { Classifier } from '../classifier/classifier';
import { detectLanguage } from '../classifier/language';
import type { RecentTurn } from '../classifier/prompt';
import { evaluateSuggestionGate } from '../config/gate';
import type { ConfigService } from '../config/service';
import type { Db, Queryable } from '../db';
import { EventStore } from '../events/store';
import { assignArm } from './experiment';

/**
 * S4 Suggestion Decision Engine (architecture §6.2), cheapest check first:
 *   gate (fresh config → enabled/dogfood → kill switch → rollout) → opt-out → pause → conversation cap →
 *   organic voice in this conversation → weekly cap → arm → classify → threshold → copy.
 * Fails closed: any error, timeout or doubt means no card. Never throws into the chat path.
 *
 * Two steps, so a card that arrives too late never counts toward the caps:
 *   decide() runs in parallel with the answer (no writes besides the arm assignment).
 *   commit() runs after answer.complete: re-checks kill switch, prefs and caps under a per-user lock, then
 *   records the impression (treatment = shown, control = shadow `eligible_control`) and emits `suggestion_eligible`.
 */

export type NoReason =
  | 'stale_config' | 'disabled' | 'kill_switch' | 'rollout' | 'opted_out' | 'paused' | 'conv_cap' | 'conv_has_voice'
  | 'weekly_cap' | 'prefilter' | 'not_voice_friendly' | 'language_not_supported' | 'low_confidence' | 'classifier_error' | 'error';

export type Decision =
  | { eligible: false; reason: NoReason; arm?: Arm; classifier?: ClassifierResult; ms: number }
  | { eligible: true; arm: Arm; dogfood: boolean; intent: VoiceIntent; classifier: ClassifierResult; card: SuggestionCardPayload; ms: number };

export interface DecideInput {
  user: AuthUser;
  conversationId: string;
  /** The assistant message the card would sit under. */
  messageId: string;
  query: string;
  recentTurns: RecentTurn[];
}

/** Statuses that count as an impression for the frequency caps (`late` does not). */
const COUNTED = `('shown','tapped','dismissed','opted_out','ignored','eligible_control')`;

export const suggestionIdFor = (messageId: string) => `sg_${messageId}`;

export class SuggestionEngine {
  private readonly events: EventStore;

  constructor(
    private readonly db: Db,
    private readonly classifier: Classifier | null,
    private readonly config: ConfigService,
    private readonly log?: { warn: (o: object, m: string) => void },
  ) {
    this.events = new EventStore(db);
  }

  private gate(user: AuthUser, language: string) {
    return evaluateSuggestionGate(this.config.get(), { userId: user.id, region: user.region, language, cohort: user.cohort }, { fresh: this.config.isFresh() });
  }

  /** Prefs + caps. Shared by decide() and commit() (where it runs under the per-user lock). */
  private async userChecks(c: Queryable, userId: string, conversationId: string, cfg: SvsConfig): Promise<NoReason | null> {
    const prefs = await c.query<{ suggestions_enabled: boolean; paused: boolean }>(
      'SELECT suggestions_enabled, (paused_until IS NOT NULL AND paused_until > now()) AS paused FROM voice_prefs WHERE user_id = $1',
      [userId],
    );
    const p = prefs.rows[0];
    if (p && !p.suggestions_enabled) return 'opted_out';
    if (p?.paused) return 'paused';
    const conv = await c.query<{ n: number; voice: boolean }>(
      `SELECT (SELECT count(*)::int FROM suggestions WHERE conversation_id = $1 AND status IN ${COUNTED}) AS n,
              EXISTS (SELECT 1 FROM voice_sessions WHERE conversation_id = $1 AND entry_point <> 'suggestion_card') AS voice`,
      [conversationId],
    );
    if (conv.rows[0]!.n >= cfg.cap.perConversation) return 'conv_cap';
    if (conv.rows[0]!.voice) return 'conv_has_voice';
    const week = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM suggestions WHERE user_id = $1 AND status IN ${COUNTED} AND evaluated_at > now() - make_interval(hours => $2)`,
      [userId, cfg.cap.rollingWindowHours],
    );
    if (week.rows[0]!.n >= cfg.cap.perRollingWeek) return 'weekly_cap';
    return null;
  }

  async decide(input: DecideInput): Promise<Decision> {
    const started = Date.now();
    const ms = () => Date.now() - started;
    try {
      const cfg = this.config.get();
      const language = detectLanguage(input.query);
      const gate = this.gate(input.user, language);
      if (!gate.allowed) return { eligible: false, reason: gate.reason as NoReason, ms: ms() };
      const userNo = await this.userChecks(this.db, input.user.id, input.conversationId, cfg);
      if (userNo) return { eligible: false, reason: userNo, ms: ms() };

      // Dogfood users are outside the experiment and always see the treatment (EX-02).
      const dogfood = gate.reason === 'dogfood';
      const arm: Arm = dogfood ? 'treatment' : await assignArm(this.db, input.user.id, cfg);

      if (!this.classifier) return { eligible: false, reason: 'classifier_error', arm, ms: ms() };
      const result = await this.classifier.classify({ query: input.query, recentTurns: input.recentTurns }, { userId: input.user.id, conversationId: input.conversationId, arm });
      if (result.stage === 'prefilter') return { eligible: false, reason: 'prefilter', arm, classifier: result, ms: ms() };
      if (result.stage === 'error') return { eligible: false, reason: 'classifier_error', arm, classifier: result, ms: ms() };
      if (result.intent === 'none') return { eligible: false, reason: 'not_voice_friendly', arm, classifier: result, ms: ms() };
      // Only languages the classifier was evaluated on may produce a card (edge-case CL-06).
      if (!cfg.classifier.languages.includes(result.language)) return { eligible: false, reason: 'language_not_supported', arm, classifier: result, ms: ms() };
      const intent = cardIntent(result, this.config.get().classifier.thresholds);
      if (!intent) return { eligible: false, reason: 'low_confidence', arm, classifier: result, ms: ms() };

      // FR-11: copy in the query's language when that copy is enabled (hi, bn, mr, te); English otherwise
      // (Hinglish readers use Latin script).
      const lang = copyLanguageFor(result.language);
      const copyLanguage = cfg.copy.languages.includes(lang) ? lang : 'en';
      const card = suggestionCard(suggestionIdFor(input.messageId), intent, copyLanguage);
      return { eligible: true, arm, dogfood, intent, classifier: result, card, ms: ms() };
    } catch (err) {
      this.log?.warn({ err: (err as Error).message }, 'suggestion decision failed; no card');
      return { eligible: false, reason: 'error', ms: ms() };
    }
  }

  /**
   * After answer.complete: atomically re-check and record the impression. Returns whether the treatment card
   * may be sent. Control users get a shadow impression (same caps) and never a card.
   */
  async commit(input: DecideInput, d: Extract<Decision, { eligible: true }>): Promise<{ send: boolean; outcome: string }> {
    try {
      const cfg = this.config.get();
      // Kill switch may have been flipped while the answer streamed (edge-case DE-21).
      const gate = this.gate(input.user, d.classifier.language);
      if (!gate.allowed) return { send: false, outcome: gate.reason };
      const outcome = await this.db.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`svs-caps:${input.user.id}`]);
        const no = await this.userChecks(c, input.user.id, input.conversationId, cfg);
        if (no) return no;
        const status = d.arm === 'treatment' ? 'shown' : 'eligible_control';
        const ins = await c.query(
          `INSERT INTO suggestions (id, message_id, conversation_id, user_id, intent, confidence, language, arm, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [d.card.suggestion_id, input.messageId, input.conversationId, input.user.id, d.intent, d.classifier.confidence, d.classifier.language, d.arm, status],
        );
        return (ins.rowCount ?? 0) > 0 ? (status as string) : 'duplicate';
      });
      if (outcome === 'shown' || outcome === 'eligible_control') {
        await this.events
          .emitServer('suggestion_eligible', { userId: input.user.id, cohort: input.user.cohort, experimentId: d.dogfood ? null : cfg.experiment.id, arm: d.arm }, {
            sessionId: input.conversationId,
            intentType: d.intent,
            language: d.classifier.language,
            props: { suggestion_id: d.card.suggestion_id, confidence: d.classifier.confidence, classifier_version: d.classifier.model_version.slice(0, 64), dogfood: d.dogfood },
          })
          .catch((err: unknown) => this.log?.warn({ err: (err as Error).message }, 'failed to emit suggestion_eligible'));
      }
      return { send: outcome === 'shown', outcome };
    } catch (err) {
      this.log?.warn({ err: (err as Error).message }, 'suggestion commit failed; no card');
      return { send: false, outcome: 'error' };
    }
  }

  /** The decision finished after the grace window: keep a `late` row for analysis; it never counts toward caps. */
  async recordLate(input: DecideInput, d: Extract<Decision, { eligible: true }>) {
    await this.db
      .query(
        `INSERT INTO suggestions (id, message_id, conversation_id, user_id, intent, confidence, language, arm, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'late') ON CONFLICT (id) DO NOTHING`,
        [d.card.suggestion_id, input.messageId, input.conversationId, input.user.id, d.intent, d.classifier.confidence, d.classifier.language, d.arm],
      )
      .catch(() => {});
  }

  /** One reason-code row per answered message (fire-and-forget). */
  recordOutcome(input: DecideInput, outcome: string, d: Decision | null) {
    const c = d?.classifier;
    this.db
      .query(
        `INSERT INTO suggestion_decisions (user_id, conversation_id, message_id, outcome, arm, intent, confidence, language, classifier_stage, classifier_ms, decision_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [input.user.id, input.conversationId, input.messageId, outcome, d?.arm ?? null, c?.intent ?? null, c?.confidence ?? null, c?.language ?? null, c?.stage ?? null, c?.latency_ms ?? null, d?.ms ?? null],
      )
      .catch((err: unknown) => this.log?.warn({ err: (err as Error).message }, 'failed to record suggestion decision'));
  }
}
