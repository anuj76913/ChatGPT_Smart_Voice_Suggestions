import { cardIntent, INTENT_LABELS, VOICE_INTENTS, type ClassifierLanguage, type IntentLabel, type VoiceIntent } from '@svs/shared';

/**
 * P2.5 eval metrics (pure functions, unit-tested).
 * A "card" is shown when the predicted intent is a voice intent with confidence ≥ its threshold.
 * Precision = correct cards / all cards (the PRD FR-1 gate, ≥85%). Recall = correct cards / voice-labelled main-set rows.
 * Ambiguous-set rows are gold `none`: any card there is a failure (PRD edge case).
 */
export interface GoldRow {
  id: string;
  text: string;
  label: IntentLabel;
  set: 'main' | 'ambiguous';
  language: ClassifierLanguage;
}

export interface PredRow {
  id: string;
  intent: IntentLabel;
  confidence: number;
  /** Latency of the production-budget attempt. */
  latency_ms: number;
  /** True when the production-budget attempt timed out (the label came from a longer retry). */
  prod_timeout?: boolean;
  /** Set when the row never got a model label. Treated as no card. */
  error?: string;
  /** Rows the prefilter rejects never reach the model. */
  prefiltered?: boolean;
}

export type Thresholds = Record<VoiceIntent, number>;

export interface IntentStats {
  support: number;
  cards: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}

export interface EvalResult {
  rows: number;
  cards: number;
  correctCards: number;
  precision: number | null;
  recall: number | null;
  voiceSupport: number;
  perIntent: Record<VoiceIntent, IntentStats>;
  byLanguage: Record<string, { cards: number; correct: number; support: number; precision: number | null; recall: number | null }>;
  /** confusion[gold][predicted card intent or 'no_card'] */
  confusion: Record<string, Record<string, number>>;
  ambiguousCards: string[];
  falsePositives: Array<{ id: string; gold: IntentLabel; card: VoiceIntent; confidence: number }>;
  falseNegatives: Array<{ id: string; gold: VoiceIntent; predicted: IntentLabel; confidence: number; reason: string }>;
  errors: number;
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

/** Card decision for one row. `prodTimeoutsAsNone` reproduces production, where a timeout means no card. */
export function rowCard(p: PredRow | undefined, thresholds: Thresholds, prodTimeoutsAsNone = false): VoiceIntent | null {
  if (!p || p.error || p.prefiltered) return null;
  if (prodTimeoutsAsNone && p.prod_timeout) return null;
  return cardIntent(p, thresholds);
}

export function evaluate(gold: GoldRow[], preds: Map<string, PredRow>, thresholds: Thresholds, opts: { prodTimeoutsAsNone?: boolean } = {}): EvalResult {
  const perIntent = Object.fromEntries(VOICE_INTENTS.map((i) => [i, { support: 0, cards: 0, tp: 0, fp: 0, fn: 0, precision: null, recall: null }])) as Record<VoiceIntent, IntentStats>;
  const confusion: Record<string, Record<string, number>> = {};
  for (const g of INTENT_LABELS) confusion[g] = Object.fromEntries([...VOICE_INTENTS, 'no_card'].map((k) => [k, 0]));
  const byLanguage: EvalResult['byLanguage'] = {};
  const res: EvalResult = {
    rows: gold.length, cards: 0, correctCards: 0, precision: null, recall: null, voiceSupport: 0, perIntent, byLanguage, confusion,
    ambiguousCards: [], falsePositives: [], falseNegatives: [], errors: 0,
  };

  for (const g of gold) {
    const p = preds.get(g.id);
    if (p?.error) res.errors++;
    const card = rowCard(p, thresholds, opts.prodTimeoutsAsNone);
    const lang = (byLanguage[g.language] ??= { cards: 0, correct: 0, support: 0, precision: null, recall: null });
    confusion[g.label]![card ?? 'no_card']! += 1;
    const isVoiceGold = g.label !== 'none' && g.set === 'main';
    if (isVoiceGold) {
      res.voiceSupport++;
      perIntent[g.label as VoiceIntent].support++;
      lang.support++;
    }
    if (card) {
      res.cards++;
      perIntent[card].cards++;
      lang.cards++;
      if (card === g.label) {
        res.correctCards++;
        perIntent[card].tp++;
        lang.correct++;
      } else {
        perIntent[card].fp++;
        res.falsePositives.push({ id: g.id, gold: g.label, card, confidence: p!.confidence });
        if (g.set === 'ambiguous') res.ambiguousCards.push(g.id);
      }
    }
    if (isVoiceGold && card !== g.label) {
      perIntent[g.label as VoiceIntent].fn++;
      const reason = !p ? 'no prediction' : p.prefiltered ? 'prefilter' : p.error ? `error:${p.error}` : opts.prodTimeoutsAsNone && p.prod_timeout ? 'timeout' : p.intent !== g.label ? 'wrong label' : 'below threshold';
      res.falseNegatives.push({ id: g.id, gold: g.label as VoiceIntent, predicted: p?.intent ?? 'none', confidence: p?.confidence ?? 0, reason });
    }
  }
  for (const s of Object.values(perIntent)) {
    s.precision = ratio(s.tp, s.cards);
    s.recall = ratio(s.tp, s.support);
  }
  for (const l of Object.values(byLanguage)) {
    l.precision = ratio(l.correct, l.cards);
    l.recall = ratio(l.correct, l.support);
  }
  res.precision = ratio(res.correctCards, res.cards);
  res.recall = ratio(res.correctCards, res.voiceSupport);
  return res;
}

export const SWEEP_THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99];

export interface SweepRow {
  threshold: number;
  cards: number;
  tp: number;
  precision: number | null;
  recall: number | null;
  ambiguousCards: number;
}

/** Precision/recall of one intent's cards as its threshold varies (other intents unaffected). */
export function sweepIntent(gold: GoldRow[], preds: Map<string, PredRow>, intent: VoiceIntent, candidates = SWEEP_THRESHOLDS): SweepRow[] {
  const support = gold.filter((g) => g.set === 'main' && g.label === intent).length;
  return candidates.map((t) => {
    let cards = 0;
    let tp = 0;
    let amb = 0;
    for (const g of gold) {
      const p = preds.get(g.id);
      if (!p || p.error || p.prefiltered || p.intent !== intent || p.confidence < t) continue;
      cards++;
      if (g.label === intent) tp++;
      else if (g.set === 'ambiguous') amb++;
    }
    return { threshold: t, cards, tp, precision: ratio(tp, cards), recall: ratio(tp, support), ambiguousCards: amb };
  });
}

/**
 * P2.6 threshold choice per intent: the lowest threshold (most recall) whose precision ≥ `target`
 * and which shows no card on the ambiguous set. Precision beats recall (PRD: a wrong card is the pushy failure).
 * If no threshold qualifies, use `ceiling` (the intent effectively never shows a card) and flag it.
 */
export function chooseThresholds(gold: GoldRow[], preds: Map<string, PredRow>, target = 0.9, ceiling = 0.99): { thresholds: Thresholds; flagged: VoiceIntent[] } {
  const thresholds = {} as Thresholds;
  const flagged: VoiceIntent[] = [];
  for (const intent of VOICE_INTENTS) {
    // The model reports confidence in fine steps (e.g. 0.94–0.98), so a fixed grid can jump straight past the
    // only separating value. Also try every confidence the model actually produced for this intent.
    const observed = [...preds.values()].filter((p) => p.intent === intent && !p.error && !p.prefiltered).map((p) => Math.round(p.confidence * 100) / 100);
    const candidates = [...new Set([...SWEEP_THRESHOLDS, ...observed])].filter((t) => t >= 0.5 && t <= ceiling).sort((a, b) => a - b);
    const ok = sweepIntent(gold, preds, intent, candidates).find((r) => r.tp > 0 && (r.precision ?? 0) >= target && r.ambiguousCards === 0);
    if (ok) thresholds[intent] = ok.threshold;
    else {
      thresholds[intent] = ceiling;
      flagged.push(intent);
    }
  }
  return { thresholds, flagged };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}
