/**
 * Validates a labelled intent dataset (JSONL) and reports progress toward the Phase 2 gate.
 *   npm run dataset:validate                         (validates data/intent-eval/seed.jsonl)
 *   npx tsx scripts/dataset/validate.ts <file.jsonl> [--gate]
 *
 * --gate fails the run unless the Phase 2 targets are met (≥1,000 main-set rows, both languages, ambiguous set present).
 */
import { INTENT_LABELS } from '@svs/shared';
import { normalise, readJsonl } from './schema';

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
const gate = process.argv.includes('--gate');
if (!file) {
  console.error('Usage: tsx scripts/dataset/validate.ts <file.jsonl> [--gate]');
  process.exit(1);
}

const { rows, errors } = readJsonl(file);

// Duplicate ids and duplicate texts
const seenIds = new Map<string, number>();
const seenText = new Map<string, string>();
for (const r of rows) {
  seenIds.set(r.id, (seenIds.get(r.id) ?? 0) + 1);
  const key = normalise(r.text);
  const prior = seenText.get(key);
  if (prior) errors.push(`duplicate text: ${r.id} repeats ${prior}`);
  else seenText.set(key, r.id);
}
for (const [id, n] of seenIds) if (n > 1) errors.push(`duplicate id: ${id} (${n}×)`);

// Counts
const main = rows.filter((r) => r.set === 'main');
const ambiguous = rows.filter((r) => r.set === 'ambiguous');
const table: Record<string, Record<string, number>> = {};
for (const label of INTENT_LABELS) table[label] = { en: 0, hinglish: 0, hi: 0, other: 0 };
for (const r of main) table[r.label]![r.language]! += 1;

console.log(`File: ${file}`);
console.log(`Rows: ${rows.length} (main ${main.length}, ambiguous ${ambiguous.length}); reviewed ${rows.filter((r) => r.reviewed).length}`);
console.log('\nMain set by label × language:');
console.log(`  ${'label'.padEnd(16)}${'en'.padStart(6)}${'hinglish'.padStart(10)}${'hi'.padStart(6)}${'other'.padStart(7)}${'total'.padStart(7)}`);
for (const label of INTENT_LABELS) {
  const c = table[label]!;
  const total = c.en! + c.hinglish! + c.hi! + c.other!;
  console.log(
    `  ${label.padEnd(16)}${String(c.en).padStart(6)}${String(c.hinglish).padStart(10)}${String(c.hi).padStart(6)}${String(c.other).padStart(7)}${String(total).padStart(7)}`,
  );
}

// Phase 2 gate (implementation-plan P2 exit criteria; FR-1)
const checks = [
  { name: '≥1,000 main-set rows', ok: main.length >= 1000 },
  { name: 'English and Hinglish both present', ok: main.some((r) => r.language === 'en') && main.some((r) => r.language === 'hinglish') },
  { name: 'every label has ≥1 row', ok: INTENT_LABELS.every((l) => main.some((r) => r.label === l)) },
  { name: 'ambiguous set present', ok: ambiguous.length > 0 },
  { name: 'all rows human-reviewed', ok: rows.every((r) => r.reviewed) },
];
console.log('\nPhase 2 gate:');
for (const c of checks) console.log(`  ${c.ok ? '✔' : '○'} ${c.name}`);

if (errors.length) {
  console.error(`\n✖ ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\n✔ Schema valid, no duplicates.');
if (gate && !checks.every((c) => c.ok)) {
  console.error('✖ Phase 2 gate not met.');
  process.exit(1);
}
