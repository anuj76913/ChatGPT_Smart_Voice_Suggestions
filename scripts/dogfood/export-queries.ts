/**
 * P8.2 export real dogfood queries for labelling, **only from participants who granted research consent**.
 *
 *   npm run dogfood:export -- [--since 2026-11-01] [--prefilter-sample 0.2] [--database-url …]
 *
 * Takes the learner messages of dogfood-cohort users with research_consent = 'granted':
 *   - every message that reached the classifier (the model's guess is attached as a hint, never as the label)
 *   - a random share of prefilter-rejected messages, to measure what the prefilter misses (recall)
 * Obvious personal data is masked (emails, phone numbers, URLs, long digit runs). Names can't be masked reliably,
 * so the labeller drops any row that still identifies someone. Output: data/intent-eval/private/ (git-ignored).
 * Rows already exported or labelled (same text) are skipped.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { ConfigService } from '../../apps/server/src/config/service';
import { createDb } from '../../apps/server/src/db';
import { detectLanguage } from '../../apps/server/src/classifier/language';
import { scrub } from '../../apps/server/src/privacy/scrub';
import { normalise } from '../dataset/schema';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DIR = 'data/intent-eval/private';
const since = flag('since') ? new Date(flag('since')!) : new Date(Date.now() - 14 * 86_400_000);
const sampleShare = Number(flag('prefilter-sample') ?? '0.2');

export interface RawRow {
  id: string;
  text: string;
  language: string;
  stage: 'model' | 'error' | 'prefilter';
  model_intent: string | null;
  model_confidence: number | null;
  exported_at: string;
}

async function main() {
  const url = flag('database-url') ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL or pass --database-url');
  const db = createDb(url)!;
  try {
    const config = new ConfigService(db, { reloadMs: 60000 });
    await config.load();
    const cohorts = config.get().dogfoodCohorts;
    if (!cohorts.length) throw new Error('No dogfood cohorts in config (npm run ops:config -- preset dogfood-baseline)');
    const { rows } = await db.query<{ text: string; stage: string | null; intent: string | null; confidence: number | null }>(
      `SELECT q.content AS text, d.classifier_stage AS stage, d.intent, d.confidence
         FROM messages q
         JOIN conversations c ON c.id = q.conversation_id
         JOIN users u ON u.id = c.user_id
         LEFT JOIN messages a ON a.reply_to = q.id
         LEFT JOIN LATERAL (SELECT classifier_stage, intent, confidence FROM suggestion_decisions WHERE message_id = a.id ORDER BY at DESC LIMIT 1) d ON true
        WHERE q.role = 'user' AND q.created_at >= $1 AND u.cohort = ANY($2) AND u.research_consent = 'granted' AND u.research_consent_at <= q.created_at`,
      [since.toISOString(), cohorts],
    );
    // Skip anything already exported or labelled.
    mkdirSync(DIR, { recursive: true });
    const known = new Set<string>();
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jsonl')))
      for (const line of readFileSync(`${DIR}/${f}`, 'utf8').split('\n')) if (line.trim()) known.add(normalise((JSON.parse(line) as { text: string }).text));

    const out: RawRow[] = [];
    let skippedPrefilter = 0;
    for (const r of rows) {
      const text = scrub(r.text.trim()).slice(0, 2000);
      const key = normalise(text);
      if (!text || known.has(key)) continue;
      const stage = r.stage === 'model' || r.stage === 'error' ? r.stage : 'prefilter';
      if (stage === 'prefilter' && Math.random() >= sampleShare) {
        skippedPrefilter++;
        continue;
      }
      known.add(key);
      out.push({
        id: `df-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
        text,
        language: detectLanguage(text),
        stage,
        model_intent: r.intent,
        model_confidence: r.confidence,
        exported_at: new Date().toISOString(),
      });
    }
    const file = `${DIR}/raw-${new Date().toISOString().slice(0, 10)}.jsonl`;
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, prev + out.map((r) => JSON.stringify(r)).join('\n') + (out.length ? '\n' : ''));
    console.log(`✔ ${out.length} new queries → ${file} (consenting dogfood users since ${since.toISOString().slice(0, 10)}; ${skippedPrefilter} prefilter-rejected not sampled)`);
    console.log('Next: npm run dataset:label -- --labeler <your-name> --in ' + file);
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.includes('export-queries')) {
  main().catch((err: unknown) => {
    console.error(`✖ ${(err as Error).message}`);
    process.exit(1);
  });
}
