/**
 * P8.2 labelling CLI for exported dogfood queries (labelling guidelines: docs/phase0/labelling-guidelines.md).
 *
 *   npm run dataset:label -- --labeler <name> --in data/intent-eval/private/raw-YYYY-MM-DD.jsonl
 *                            [--out data/intent-eval/private/dogfood.jsonl] [--blind]
 *
 * Shows one query at a time (with the classifier's guess, unless --blind) and asks for the label:
 *   1 mock_interview · 2 spoken_english · 3 viva_revision · 4 pronunciation · 0 none
 *   a ambiguous (label none, ambiguous set) · x drop (identifies someone / junk) · s skip · q quit
 * Writes schema-valid rows (source "dogfood", reviewed true) to --out, resumable. For double labelling, give the
 * second labeller another --out (e.g. data/intent-eval/labellers/<name>.jsonl) and --blind, then run
 * npm run dataset:agreement -- a.jsonl b.jsonl.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from "node:readline";
import { CLASSIFIER_LANGUAGES } from '@svs/shared';
import { LabelledQuerySchema, normalise, type LabelledQuery } from './schema';

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const labeler = flag('labeler');
const input = flag('in');
const out = flag('out') ?? 'data/intent-eval/private/dogfood.jsonl';
const blind = args.includes('--blind');
if (!labeler || !input) {
  console.error('Usage: npm run dataset:label -- --labeler <name> --in <raw.jsonl> [--out <file>] [--blind]');
  process.exit(1);
}

const KEYS: Record<string, LabelledQuery['label']> = { '1': 'mock_interview', '2': 'spoken_english', '3': 'viva_revision', '4': 'pronunciation', '0': 'none' };
const raw = readFileSync(input, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { id: string; text: string; language: string; model_intent: string | null; model_confidence: number | null });
const done = new Set<string>();
if (existsSync(out)) for (const l of readFileSync(out, 'utf8').split('\n')) if (l.trim()) done.add(normalise((JSON.parse(l) as LabelledQuery).text));
const dropped = `${out}.dropped`;
if (existsSync(dropped)) for (const l of readFileSync(dropped, 'utf8').split('\n')) if (l.trim()) done.add(l.trim());

const todo = raw.filter((r) => !done.has(normalise(r.text)) && !done.has(r.id));
console.log(`${todo.length} to label (${raw.length - todo.length} already done) → ${out}\nKeys: 1 interview · 2 spoken English · 3 viva · 4 pronunciation · 0 none · a ambiguous · x drop · s skip · q quit\n`);
// Read answers line by line from an iterator: works in a terminal and with piped input (question() drops
// lines that arrive before it is called, so it can't be used with a pipe).
const rl = createInterface({ input: process.stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();
const nextAnswer = async (): Promise<string> => {
  process.stdout.write('label> ');
  const n = await lines.next();
  return n.done ? 'q' : String(n.value).trim().toLowerCase(); // end of input = quit
};
let labelled = 0;
for (const [i, r] of todo.entries()) {
  console.log(`[${i + 1}/${todo.length}] (${r.language}) ${r.text}`);
  if (!blind && r.model_intent) console.log(`    classifier guess: ${r.model_intent} ${r.model_confidence?.toFixed(2) ?? ''}`);
  let answer = '';
  for (;;) {
    answer = await nextAnswer();
    if (answer in KEYS || ['a', 'x', 's', 'q'].includes(answer)) break;
    console.log('  use 1-4, 0, a, x, s or q');
  }
  if (answer === 'q') break;
  if (answer === 's') continue;
  if (answer === 'x') {
    appendFileSync(dropped, `${r.id}\n`); // the id only, never the text
    continue;
  }
  const row: LabelledQuery = {
    id: r.id,
    text: r.text,
    language: ((CLASSIFIER_LANGUAGES as readonly string[]).includes(r.language) ? r.language : 'other') as LabelledQuery['language'],
    label: answer === 'a' ? 'none' : KEYS[answer]!,
    set: answer === 'a' ? 'ambiguous' : 'main',
    source: 'dogfood',
    labeler,
    reviewed: true,
  };
  LabelledQuerySchema.parse(row);
  appendFileSync(out, `${JSON.stringify(row)}\n`);
  labelled++;
}
rl.close();
console.log(`\n✔ ${labelled} labelled this session → ${out}. Then: npm run eval:classifier (re-tune with --write-thresholds) and npm run eval:check.`);
