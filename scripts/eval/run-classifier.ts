/**
 * P2.5 live classifier eval against Groq (needs GROQ_API_KEY). Resumable and rate-limit aware.
 *
 *   npm run eval:classifier                          primary + fallback model, then write the report
 *   npm run eval:classifier -- --models primary      one model only
 *   npm run eval:classifier -- --write-thresholds    also run the threshold sweep and write classifier-thresholds.json (P2.6)
 *   npm run eval:classifier -- --report-only         rebuild the report from cached predictions (no Groq calls)
 *   npm run eval:classifier -- --limit 20            only classify the next 20 uncached rows
 *
 * Predictions are cached per model+prompt version in data/intent-eval/results/ (ids and labels only, no text),
 * so an interrupted run resumes, and CI (`npm run eval:check`) can re-score them without a key.
 * Each row is first classified with the production time budget (latency profile, P2.7). If that times out,
 * it is retried with a long budget so the quality metrics still get a label; both views are reported.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { DEFAULT_SVS_CONFIG, mergeConfig, type ClassifierResult } from '@svs/shared';
import { Classifier } from '../../apps/server/src/classifier/classifier';
import { chooseThresholds, evaluate } from '../../apps/server/src/classifier/metrics';
import { prefilter } from '../../apps/server/src/classifier/prefilter';
import { LlmError } from '../../apps/server/src/llm/errors';
import { LlmGateway } from '../../apps/server/src/llm/gateway';
import { readJsonl } from '../dataset/schema';
import {
  assemble,
  configuredModels,
  currentThresholds,
  DATASET,
  loadAllRows,
  loadCache,
  loadGold,
  modelVersion,
  renderReport,
  REPORT,
  RESULTS_DIR,
  resultsPath,
  textSha,
  type CachedPrediction,
  type ModelSection,
} from './shared';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const roles = (opt('models') ?? 'primary,fallback').split(',') as Array<'primary' | 'fallback'>;
const limit = opt('limit') ? Number(opt('limit')) : Infinity;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function classifierFor(model: string, budgetMs: number) {
  const cfg = mergeConfig(DEFAULT_SVS_CONFIG, {
    llm: { models: { classifier: { primary: model, fallback: null } }, maxRetries: 0, timeoutsMs: { classifier: budgetMs } },
    classifier: { timeoutMs: budgetMs },
  });
  const gw = new LlmGateway({ apiKey: process.env.GROQ_API_KEY!, baseUrl: process.env.GROQ_BASE_URL ?? cfg.llm.baseUrl, getConfig: () => cfg });
  return new Classifier(gw, () => cfg);
}

/** Calls predict(), waiting out rate limits. Returns the result or the final error. */
async function predictWithBackoff(clf: Classifier, text: string): Promise<ClassifierResult | LlmError> {
  let transient = 0;
  for (;;) {
    try {
      return await clf.predict({ query: text });
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError('network', String(e));
      if (err.kind === 'rate_limited' || err.kind === 'busy') {
        const wait = (err.details.retryAfterMs ?? 3000) + 300;
        process.stdout.write(` (rate limited, waiting ${Math.round(wait / 1000)}s)`);
        await sleep(wait);
        continue;
      }
      if ((err.kind === 'server' || err.kind === 'network' || err.kind === 'invalid_output') && transient++ < 2) {
        await sleep(1500);
        continue;
      }
      return err;
    }
  }
}

async function runModel(model: string, gold: ReturnType<typeof loadGold>) {
  const prodBudget = DEFAULT_SVS_CONFIG.llm.timeoutsMs.classifier;
  const prod = classifierFor(model, prodBudget);
  const slow = classifierFor(model, 20000);
  const cache = loadCache(model);
  const todo = gold.filter((g) => {
    if (!prefilter(g.text).pass) return false;
    const c = cache.get(g.id);
    return !c || c.text_sha !== textSha(g.text) || c.model_version !== modelVersion(model);
  });
  const batch = todo.slice(0, limit);
  console.log(`\n▶ ${model}: ${batch.length} rows to classify (${todo.length} uncached, ${gold.length} total)`);
  mkdirSync(RESULTS_DIR, { recursive: true });
  for (const [i, g] of batch.entries()) {
    process.stdout.write(`  [${i + 1}/${batch.length}] ${g.id}`);
    let out = await predictWithBackoff(prod, g.text);
    let prodTimeout = false;
    let latency = out instanceof LlmError ? prodBudget : out.latency_ms;
    if (out instanceof LlmError && out.kind === 'timeout') {
      prodTimeout = true;
      out = await predictWithBackoff(slow, g.text);
    }
    const row: CachedPrediction =
      out instanceof LlmError
        ? { id: g.id, text_sha: textSha(g.text), model_version: modelVersion(model), intent: 'none', confidence: 0, language: 'other', latency_ms: latency, prod_timeout: prodTimeout, error: out.kind }
        : { id: g.id, text_sha: textSha(g.text), model_version: modelVersion(model), intent: out.intent, confidence: out.confidence, language: out.language, latency_ms: prodTimeout ? latency : out.latency_ms, prod_timeout: prodTimeout };
    appendFileSync(resultsPath(model), `${JSON.stringify(row)}\n`);
    console.log(` → ${row.error ? `ERROR ${row.error}` : `${row.intent} ${row.confidence}`} · ${row.latency_ms} ms${prodTimeout ? ' (prod timeout)' : ''} · gold ${g.label}`);
  }
}

async function main() {
  const gold = loadGold();
  const models = configuredModels();
  if (!flag('report-only')) {
    if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set (put it in .env).');
    for (const role of roles) {
      const model = models[role];
      if (model) await runModel(model, gold);
    }
  }

  let thresholds = currentThresholds();
  const notes: string[] = [];
  const reviewed = loadAllRows().filter((r) => r.reviewed).length;
  notes.push(
    reviewed < 1000
      ? `**Dataset status:** ${reviewed} human-reviewed rows. The Phase 2 exit criterion needs ≥1,000 human-labelled English + Hinglish queries; these results are **provisional** (synthetic seed data).`
      : `**Dataset status:** ${reviewed} human-reviewed rows.`,
  );

  if (flag('write-thresholds')) {
    const { preds, missing } = assemble(gold, models.primary);
    if (missing.length) throw new Error(`cannot tune: ${missing.length} primary-model predictions missing`);
    const { thresholds: tuned, flagged } = chooseThresholds(gold, preds, 0.9);
    thresholds = tuned;
    const file = 'packages/shared/src/classifier-thresholds.json';
    const existing = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      file,
      `${JSON.stringify({ ...existing, tunedFor: modelVersion(models.primary), tunedOn: new Date().toISOString().slice(0, 10), tuningTarget: 'per-intent precision ≥ 0.90 and no ambiguous-set cards', dataset: `${DATASET} (${gold.length} rows)`, flagged, thresholds: tuned }, null, 2)}\n`,
    );
    notes.push(`Thresholds re-tuned on this run (per-intent precision ≥ 90%, zero ambiguous cards)${flagged.length ? `; no qualifying threshold for: ${flagged.join(', ')}` : ''}.`);
    console.log(`\n✔ Wrote tuned thresholds to ${file}: ${JSON.stringify(tuned)}`);
  }

  const sections: ModelSection[] = [];
  for (const role of ['primary', 'fallback'] as const) {
    const model = models[role];
    if (!model) continue;
    const { preds, missing } = assemble(gold, model);
    if (missing.length) {
      notes.push(`\`${model}\`: ${missing.length} rows have no up-to-date prediction; re-run the eval.`);
      continue;
    }
    sections.push({ role, model, preds, quality: evaluate(gold, preds, thresholds), production: evaluate(gold, preds, thresholds, { prodTimeoutsAsNone: true }) });
  }
  mkdirSync('docs/phase2', { recursive: true });
  writeFileSync(REPORT, renderReport(gold, sections, thresholds, notes));
  for (const s of sections) {
    console.log(`\n${s.role} ${s.model}: precision ${((s.quality.precision ?? 0) * 100).toFixed(1)}% · recall ${((s.quality.recall ?? 0) * 100).toFixed(1)}% · ambiguous cards ${s.quality.ambiguousCards.length}`);
  }
  console.log(`\nReport: ${REPORT}`);
}

main().catch((err: unknown) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
