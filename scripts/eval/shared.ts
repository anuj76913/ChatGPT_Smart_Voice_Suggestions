import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_SVS_CONFIG, VOICE_INTENTS, type VoiceIntent } from '@svs/shared';
import { CLASSIFIER_PROMPT_VERSION, FEW_SHOT } from '../../apps/server/src/classifier/prompt';
import { prefilter, PREFILTER_VERSION } from '../../apps/server/src/classifier/prefilter';
import { evaluate, percentile, sweepIntent, type EvalResult, type GoldRow, type PredRow, type Thresholds } from '../../apps/server/src/classifier/metrics';
import { readJsonl } from '../dataset/schema';
import { normalise } from '../dataset/schema';

export const DATASET = 'data/intent-eval/seed.jsonl';
export const RESULTS_DIR = 'data/intent-eval/results';
export const REPORT = 'docs/phase2/eval-report.md';
export const PRECISION_GATE = DEFAULT_SVS_CONFIG.classifier.precisionTarget;

export const textSha = (text: string) => createHash('sha256').update(normalise(text)).digest('hex').slice(0, 16);
export const modelVersion = (model: string) => `${model}@${CLASSIFIER_PROMPT_VERSION}`;
export const resultsPath = (model: string) => `${RESULTS_DIR}/${model.replace(/[^a-z0-9.-]+/gi, '_')}__${CLASSIFIER_PROMPT_VERSION}.jsonl`;

/** One cached model prediction. Keyed by row id + normalised-text hash, so edits to a row invalidate it. */
export interface CachedPrediction {
  id: string;
  text_sha: string;
  model_version: string;
  intent: PredRow['intent'];
  confidence: number;
  language: string;
  latency_ms: number;
  prod_timeout: boolean;
  error?: string;
}

/**
 * Phase 8 (P8.2): real dogfood queries, labelled by people. Personal data even after scrubbing, so it lives in a
 * git-ignored folder (restricted storage in CI) and is included automatically when present.
 */
export const PRIVATE_DATASET = 'data/intent-eval/private/dogfood.jsonl';
export const datasetFiles = () => [DATASET, ...(existsSync(PRIVATE_DATASET) ? [PRIVATE_DATASET] : [])];

/** Every labelled row across the dataset files (ids must be unique across files). */
export function loadAllRows() {
  const rows = datasetFiles().flatMap((f) => {
    const r = readJsonl(f);
    if (r.errors.length) throw new Error(`${f} has invalid rows; run npx tsx scripts/dataset/validate.ts ${f}\n${r.errors.join('\n')}`);
    return r.rows;
  });
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) throw new Error(`duplicate dataset id across files: ${r.id}`);
    seen.add(r.id);
  }
  return rows;
}

export function loadGold(): GoldRow[] {
  return loadAllRows().map((r) => ({ id: r.id, text: r.text, label: r.label, set: r.set, language: r.language }));
}

export function loadCache(model: string): Map<string, CachedPrediction> {
  const path = resultsPath(model);
  const out = new Map<string, CachedPrediction>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const p = JSON.parse(line) as CachedPrediction;
    out.set(p.id, p); // later lines win (resumed runs)
  }
  return out;
}

/**
 * Joins the dataset, the *current* prefilter and cached model predictions.
 * `missing` lists rows that pass the prefilter but have no up-to-date prediction (stale cache).
 */
export function assemble(gold: GoldRow[], model: string): { preds: Map<string, PredRow>; missing: string[] } {
  const cache = loadCache(model);
  const preds = new Map<string, PredRow>();
  const missing: string[] = [];
  for (const g of gold) {
    if (!prefilter(g.text).pass) {
      preds.set(g.id, { id: g.id, intent: 'none', confidence: 1, latency_ms: 0, prefiltered: true });
      continue;
    }
    const c = cache.get(g.id);
    if (!c || c.text_sha !== textSha(g.text) || c.model_version !== modelVersion(model)) {
      missing.push(g.id);
      continue;
    }
    preds.set(g.id, { id: g.id, intent: c.intent, confidence: c.confidence, latency_ms: c.latency_ms, prod_timeout: c.prod_timeout, error: c.error });
  }
  return { preds, missing };
}

/** Few-shot examples must not leak into the eval data (they'd inflate the scores). */
export function fewShotOverlap(gold: GoldRow[]): string[] {
  const shots = new Set(FEW_SHOT.map(([q]) => normalise(q)));
  return gold.filter((g) => shots.has(normalise(g.text))).map((g) => g.id);
}

export const configuredModels = () => {
  const m = DEFAULT_SVS_CONFIG.llm.models.classifier;
  return { primary: m.primary, fallback: m.fallback };
};

export const currentThresholds = (): Thresholds => ({ ...DEFAULT_SVS_CONFIG.classifier.thresholds });

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const ms = (x: number | null) => (x === null ? '—' : `${Math.round(x)} ms`);

export interface ModelSection {
  role: 'primary' | 'fallback';
  model: string;
  quality: EvalResult;
  production: EvalResult;
  preds: Map<string, PredRow>;
}

/** Markdown eval report (P2.5 deliverable "eval report"). */
export function renderReport(gold: GoldRow[], sections: ModelSection[], thresholds: Thresholds, notes: string[]): string {
  const main = gold.filter((g) => g.set === 'main');
  const amb = gold.filter((g) => g.set === 'ambiguous');
  const voice = main.filter((g) => g.label !== 'none');
  const pfVoiceMiss = voice.filter((g) => !prefilter(g.text).pass);
  const noneRows = gold.filter((g) => g.label === 'none');
  const pfSkipped = noneRows.filter((g) => !prefilter(g.text).pass);
  const textOf = new Map(gold.map((g) => [g.id, g.text]));

  const lines: string[] = [];
  lines.push('# Phase 2 Classifier Eval Report', '');
  lines.push('> Generated by `npm run eval:classifier`. Do not edit by hand. Gate: FR-1 precision ≥ 85% and no card on the ambiguous set.', '');
  lines.push(`- **Generated:** ${new Date().toISOString()}`);
  lines.push(`- **Dataset:** ${datasetFiles().map((f) => `\`${f}\``).join(' + ')}: ${gold.length} rows (main ${main.length}, ambiguous ${amb.length})`);
  lines.push(`- **Prompt:** \`${CLASSIFIER_PROMPT_VERSION}\` · **Prefilter:** \`${PREFILTER_VERSION}\``);
  lines.push(`- **Thresholds:** ${VOICE_INTENTS.map((i) => `${i} ${thresholds[i]}`).join(' · ')}`);
  for (const n of notes) lines.push(`- ${n}`);
  lines.push('');

  lines.push('## Summary', '', '| Model | Role | Precision | Recall | Cards | Ambiguous cards | Errors | Gate |', '|---|---|---|---|---|---|---|---|');
  for (const s of sections) {
    const q = s.quality;
    const gate = (q.precision ?? 0) >= PRECISION_GATE && q.ambiguousCards.length === 0;
    lines.push(`| \`${s.model}\` | ${s.role} | ${pct(q.precision)} | ${pct(q.recall)} | ${q.cards} | ${q.ambiguousCards.length} | ${q.errors} | ${gate ? '✅ pass' : '❌ fail'} |`);
  }
  lines.push('', '_Quality numbers use the label even when the production-budget call timed out (the harness retried with a longer budget). Production numbers below count those timeouts as "no card", as the live system would._', '');

  for (const s of sections) {
    lines.push(`## ${s.role === 'primary' ? 'Primary' : 'Fallback'}: \`${s.model}\``, '');
    lines.push('### Per intent', '', '| Intent | Support | Cards | TP | FP | FN | Precision | Recall | Threshold |', '|---|---|---|---|---|---|---|---|---|');
    for (const i of VOICE_INTENTS) {
      const x = s.quality.perIntent[i];
      lines.push(`| ${i} | ${x.support} | ${x.cards} | ${x.tp} | ${x.fp} | ${x.fn} | ${pct(x.precision)} | ${pct(x.recall)} | ${thresholds[i]} |`);
    }
    lines.push('', '### By language', '', '| Language | Voice rows | Cards | Precision | Recall |', '|---|---|---|---|---|');
    for (const [l, x] of Object.entries(s.quality.byLanguage)) lines.push(`| ${l} | ${x.support} | ${x.cards} | ${pct(x.precision)} | ${pct(x.recall)} |`);
    lines.push('', '### Confusion (rows = gold label, columns = card shown)', '', `| gold \\ card | ${[...VOICE_INTENTS, 'no_card'].join(' | ')} |`, `|---|${[...VOICE_INTENTS, 'no_card'].map(() => '---').join('|')}|`);
    for (const [g, row] of Object.entries(s.quality.confusion)) lines.push(`| ${g} | ${[...VOICE_INTENTS, 'no_card'].map((k) => row[k]).join(' | ')} |`);
    lines.push('', `### False positives (${s.quality.falsePositives.length})`, '');
    if (!s.quality.falsePositives.length) lines.push('None.');
    for (const f of s.quality.falsePositives) lines.push(`- \`${f.id}\` gold **${f.gold}** → card **${f.card}** (${f.confidence}): "${textOf.get(f.id)}"`);
    lines.push('', `### Missed cards (${s.quality.falseNegatives.length})`, '');
    if (!s.quality.falseNegatives.length) lines.push('None.');
    for (const f of s.quality.falseNegatives) lines.push(`- \`${f.id}\` gold **${f.gold}** → ${f.predicted} (${f.confidence}, ${f.reason}): "${textOf.get(f.id)}"`);

    lines.push('', '### Threshold sweep (P2.6)', '', '| Intent | ' + [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99].map((t) => `≥${t}`).join(' | ') + ' |', '|---|' + '---|'.repeat(8));
    for (const i of VOICE_INTENTS) {
      const rows = sweepIntent(gold, s.preds, i, [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99]);
      lines.push(`| ${i} | ${rows.map((r) => `P ${pct(r.precision)} / R ${pct(r.recall)}`).join(' | ')} |`);
    }

    const lat = [...s.preds.values()].filter((p) => !p.prefiltered && !p.error).map((p) => p.latency_ms);
    const timeouts = [...s.preds.values()].filter((p) => p.prod_timeout).length;
    lines.push('', '### Latency (P2.7)', '', '| Model calls | p50 | p90 | p95 | max | Production timeouts (>1.5s) |', '|---|---|---|---|---|---|');
    lines.push(`| ${lat.length} | ${ms(percentile(lat, 50))} | ${ms(percentile(lat, 90))} | ${ms(percentile(lat, 95))} | ${ms(lat.length ? Math.max(...lat) : null)} | ${timeouts} |`);
    lines.push('', `**Production view** (timeouts → no card): precision ${pct(s.production.precision)}, recall ${pct(s.production.recall)}.`, '');
  }

  lines.push('## Prefilter (P2.1)', '');
  lines.push(`- Voice-labelled rows passed to the model: **${voice.length - pfVoiceMiss.length}/${voice.length}** (recall ${pct(ratioOf(voice.length - pfVoiceMiss.length, voice.length))})`);
  for (const g of pfVoiceMiss) lines.push(`  - missed \`${g.id}\`: "${g.text}"`);
  lines.push(`- \`none\` rows rejected without a Groq call: **${pfSkipped.length}/${noneRows.length}** (${pct(ratioOf(pfSkipped.length, noneRows.length))} of non-voice traffic in this set never costs a call)`);
  lines.push('');
  return lines.join('\n');
}

const ratioOf = (a: number, b: number) => (b === 0 ? null : a / b);
