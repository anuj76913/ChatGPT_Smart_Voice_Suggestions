/**
 * Inter-annotator agreement for double-labelled samples (labelling-guidelines §6).
 *   npm run dataset:agreement -- <labeller-a.jsonl> <labeller-b.jsonl>
 *
 * Joins rows by id and reports raw agreement, Cohen's kappa, the confusion matrix and every disagreement.
 * Target: kappa ≥ 0.80 before a labeller labels on their own.
 */
import { INTENT_LABELS, type IntentLabel } from '@svs/shared';
import { readJsonl } from './schema';

const [fileA, fileB] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!fileA || !fileB) {
  console.error('Usage: npm run dataset:agreement -- <labeller-a.jsonl> <labeller-b.jsonl>');
  process.exit(1);
}

const a = readJsonl(fileA);
const b = readJsonl(fileB);
for (const [name, r] of [[fileA, a], [fileB, b]] as const) {
  if (r.errors.length) {
    console.error(`✖ ${name} has ${r.errors.length} invalid row(s); run dataset:validate first.`);
    process.exit(1);
  }
}

const byIdB = new Map(b.rows.map((r) => [r.id, r.label]));
const pairs: Array<{ id: string; la: IntentLabel; lb: IntentLabel }> = [];
for (const r of a.rows) {
  const lb = byIdB.get(r.id);
  if (lb) pairs.push({ id: r.id, la: r.label, lb });
}
if (pairs.length === 0) {
  console.error('✖ No shared ids between the two files.');
  process.exit(1);
}

const n = pairs.length;
const observed = pairs.filter((p) => p.la === p.lb).length / n;
let expected = 0;
for (const label of INTENT_LABELS) {
  const pa = pairs.filter((p) => p.la === label).length / n;
  const pb = pairs.filter((p) => p.lb === label).length / n;
  expected += pa * pb;
}
const kappa = expected === 1 ? 1 : (observed - expected) / (1 - expected);

console.log(`Shared items: ${n}`);
console.log(`Raw agreement: ${(observed * 100).toFixed(1)}%`);
console.log(`Cohen's kappa: ${kappa.toFixed(3)} ${kappa >= 0.8 ? '✔ (≥0.80)' : '✖ (target ≥0.80)'}`);

console.log('\nConfusion matrix (rows = A, columns = B):');
const short = (l: string) => l.slice(0, 9);
console.log(`  ${''.padEnd(16)}${INTENT_LABELS.map((l) => short(l).padStart(11)).join('')}`);
for (const la of INTENT_LABELS) {
  const cells = INTENT_LABELS.map((lb) => String(pairs.filter((p) => p.la === la && p.lb === lb).length).padStart(11));
  console.log(`  ${la.padEnd(16)}${cells.join('')}`);
}

const disagreements = pairs.filter((p) => p.la !== p.lb);
if (disagreements.length) {
  console.log(`\nDisagreements to adjudicate (${disagreements.length}):`);
  for (const d of disagreements) console.log(`  ${d.id}: A=${d.la} B=${d.lb}`);
}
