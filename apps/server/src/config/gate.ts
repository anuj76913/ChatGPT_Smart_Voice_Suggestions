import { createHash } from 'node:crypto';
import type { KillSwitchRule, SvsConfig } from '@svs/shared';

/** Deterministic bucket in [0, buckets) for a key. Same input → same bucket on every server and run. */
export function bucketOf(key: string, buckets = 10000): number {
  const h = createHash('sha256').update(key).digest();
  return h.readUInt32BE(0) % buckets;
}

export interface GateContext {
  userId: string;
  region?: string | null;
  language?: string | null;
  cohort?: string | null;
}

export type GateReason = 'stale_config' | 'disabled' | 'kill_switch' | 'rollout' | 'dogfood' | 'ok';

export function matchesKillSwitch(rules: KillSwitchRule[], ctx: GateContext): boolean {
  return rules.some(
    (r) =>
      (r.region === undefined || r.region === ctx.region) &&
      (r.language === undefined || r.language === ctx.language) &&
      (r.cohort === undefined || r.cohort === ctx.cohort),
  );
}

/**
 * First stage of suggestion eligibility (architecture §10 evaluation order):
 *   fresh config → enabled (or dogfood cohort) → kill switch → rollout percent.
 * The S4 decision engine (Phase 3) runs its own checks only when this returns allowed.
 * Fails closed: any "no" means no card.
 */
export function evaluateSuggestionGate(cfg: SvsConfig, ctx: GateContext, opts: { fresh: boolean }): { allowed: boolean; reason: GateReason } {
  if (!opts.fresh) return { allowed: false, reason: 'stale_config' };
  const isDogfood = !!ctx.cohort && cfg.dogfoodCohorts.includes(ctx.cohort);
  if (!cfg.enabled && !isDogfood) return { allowed: false, reason: 'disabled' };
  if (matchesKillSwitch(cfg.killSwitch, ctx)) return { allowed: false, reason: 'kill_switch' };
  if (isDogfood) return { allowed: true, reason: 'dogfood' };
  const inRollout = bucketOf(`rollout:${ctx.userId}`) < Math.round(cfg.rolloutPercent * 100);
  return inRollout ? { allowed: true, reason: 'ok' } : { allowed: false, reason: 'rollout' };
}
