import type { SvsConfig } from '@svs/shared';
import type { Db } from '../db';

/**
 * P7.3 transcript retention (architecture §13.3, edge-case PV-*): finalized voice turns are kept only for
 * `privacy.voiceTranscriptRetentionDays`, then deleted. Summary tips are model text written *about* those answers,
 * so they are cleared on the same schedule. Audio is never stored, so there is nothing else to purge.
 * Not covered here: the chat recap message (Back to Chat / Continue in text) is chat content and follows the
 * existing chat-history policy.
 *
 * Runs every `privacy.purgeIntervalMs` (0 disables), in batches, one instance at a time (advisory lock).
 */
export class RetentionJob {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly deps: { db: Db; getConfig: () => SvsConfig; log?: { warn: (o: object, m: string) => void; info?: (o: object, m: string) => void }; now?: () => Date },
  ) {}

  async run(): Promise<{ turns: number; tips: number; feedback: number } | null> {
    const cfg = this.deps.getConfig().privacy;
    const now = this.deps.now?.() ?? new Date();
    const cutoff = new Date(now.getTime() - cfg.voiceTranscriptRetentionDays * 86_400_000).toISOString();
    return this.deps.db.tx(async (c) => {
      const lock = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('svs-retention', 0)) AS ok");
      if (!lock.rows[0]?.ok) return null;
      let turns = 0;
      for (;;) {
        const r = await c.query('DELETE FROM voice_turns WHERE id IN (SELECT id FROM voice_turns WHERE at < $1 LIMIT 5000)', [cutoff]);
        turns += r.rowCount ?? 0;
        if ((r.rowCount ?? 0) < 5000) break;
      }
      const tips = (await c.query('UPDATE session_summaries SET tip = NULL WHERE tip IS NOT NULL AND created_at < $1', [cutoff])).rowCount ?? 0;
      // Phase 8: dogfood problem reports (free text) are kept for their own window.
      const fbCutoff = new Date(now.getTime() - cfg.feedbackRetentionDays * 86_400_000).toISOString();
      const feedback = (await c.query('DELETE FROM feedback_reports WHERE created_at < $1', [fbCutoff])).rowCount ?? 0;
      if (turns || tips || feedback) this.deps.log?.info?.({ turns, tips, feedback, retention_days: cfg.voiceTranscriptRetentionDays }, 'purged expired voice transcripts and feedback');
      return { turns, tips, feedback };
    });
  }

  start() {
    const ms = this.deps.getConfig().privacy.purgeIntervalMs;
    if (this.timer || ms <= 0) return;
    const tick = () => void this.run().catch((err: unknown) => this.deps.log?.warn({ err: (err as Error).message }, 'transcript purge failed'));
    tick();
    this.timer = setInterval(tick, ms);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
