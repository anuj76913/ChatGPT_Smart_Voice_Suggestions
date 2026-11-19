/**
 * P2.5 CI gate for the classifier (no Groq key needed). Fails the build when:
 *  - cached predictions are stale: the prompt version, a model ID, the prefilter or a dataset row changed
 *    without re-running `npm run eval:classifier` (so every prompt/model change gets a fresh eval)
 *  - precision < 85% (FR-1) for the primary or fallback model at the *current* thresholds
 *    (so a threshold change is re-scored on every run)
 *  - any ambiguous-set query would show a card (PRD edge case)
 *  - a few-shot example leaked into the eval data
 *
 *   npm run eval:check
 */
import { VOICE_INTENTS } from '@svs/shared';
import { evaluate } from '../../apps/server/src/classifier/metrics';
import { readJsonl } from '../dataset/schema';
import { assemble, configuredModels, currentThresholds, fewShotOverlap, loadAllRows, loadGold, PRECISION_GATE } from './shared';

const failures: string[] = [];
const gold = loadGold();
const thresholds = currentThresholds();
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

const leaked = fewShotOverlap(gold);
if (leaked.length) failures.push(`few-shot examples appear in the eval data: ${leaked.join(', ')}`);

console.log(`Thresholds: ${VOICE_INTENTS.map((i) => `${i}=${thresholds[i]}`).join(' ')}`);
const models = configuredModels();
for (const [role, model] of Object.entries(models) as Array<[string, string | null]>) {
  if (!model) continue;
  const { preds, missing } = assemble(gold, model);
  if (missing.length) {
    failures.push(`${role} ${model}: ${missing.length} rows have no up-to-date prediction (prompt, model, prefilter or dataset changed). Run: npm run eval:classifier`);
    continue;
  }
  const r = evaluate(gold, preds, thresholds);
  console.log(`${role.padEnd(8)} ${model.padEnd(22)} precision ${pct(r.precision).padStart(6)} · recall ${pct(r.recall).padStart(6)} · cards ${r.cards} · ambiguous cards ${r.ambiguousCards.length} · errors ${r.errors}`);
  if (r.precision === null || r.precision < PRECISION_GATE) failures.push(`${role} ${model}: precision ${pct(r.precision)} < ${PRECISION_GATE * 100}%`);
  if (r.ambiguousCards.length) failures.push(`${role} ${model}: cards on ambiguous queries: ${r.ambiguousCards.join(', ')}`);
}

const reviewed = loadAllRows().filter((r) => r.reviewed).length;
if (reviewed < 1000) console.log(`ⓘ Provisional: ${reviewed}/1000 human-reviewed rows (Phase 2 exit criterion not yet met; not a CI failure).`);

if (failures.length) {
  console.error(`\n✖ Classifier eval gate failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('\n✔ Classifier eval gate passed.');
