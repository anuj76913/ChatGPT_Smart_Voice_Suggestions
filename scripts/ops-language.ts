/**
 * P10.3 localization ops: which languages may show cards, and turning them on safely.
 *
 *   npm run ops:language -- check [<lang>|all] [--prototype]   readiness per language (copy, eval coverage, precision)
 *   npm run ops:language -- enable <lang> [--prototype] --reason "…"   add to classifier.languages if ready
 *   npm run ops:language -- disable <lang> --reason "…"
 *   npm run ops:language -- rank [--days 30]                  languages by real query usage (for "top 3 by usage")
 * Options: --database-url <url> (default DATABASE_URL) for enable / disable / rank.
 *
 * Readiness uses the cached eval predictions of the PRIMARY classifier model (npm run eval:classifier) on every
 * dataset file (seed + private dogfood). --prototype accepts synthetic rows and draft copy, and says so.
 */
import { config as loadDotenv } from 'dotenv';
import { CLASSIFIER_LANGUAGES, COPY_LANGUAGES, COPY_STATUS, LANGUAGE_NAMES, type ClassifierLanguage, type CopyLanguage, type DeepPartial, type SvsConfig } from '@svs/shared';
import { detectLanguage } from '../apps/server/src/classifier/language';
import { evaluate } from '../apps/server/src/classifier/metrics';
import { ConfigService } from '../apps/server/src/config/service';
import { createDb } from '../apps/server/src/db';
import { languageReadiness, type LanguageEvidence } from '../apps/server/src/ops/language';
import { assemble, configuredModels, currentThresholds, loadAllRows, loadGold, PRECISION_GATE } from './eval/shared';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [cmd, arg] = positional;
const prototype = args.includes('--prototype');
const OPTS = { precisionTarget: PRECISION_GATE, minReviewedRows: 100, prototype, prototypeMinRows: 10 };
const isLang = (l: string | undefined): l is ClassifierLanguage => !!l && (CLASSIFIER_LANGUAGES as readonly string[]).includes(l) && l !== 'other';

function evidenceFor(language: ClassifierLanguage): LanguageEvidence {
  const gold = loadGold().filter((g) => g.language === language);
  const rows = loadAllRows().filter((r) => r.language === language);
  const { preds, missing } = assemble(gold, configuredModels().primary);
  const main = gold.filter((g) => g.set === 'main');
  const res = evaluate(main, preds, currentThresholds());
  const amb = gold.filter((g) => g.set === 'ambiguous');
  const ambRes = evaluate(amb, preds, currentThresholds());
  return {
    language,
    copyStatus: (COPY_LANGUAGES as string[]).includes(language) && language !== 'en' ? COPY_STATUS[language as CopyLanguage] : null,
    mainRows: main.length,
    reviewedMainRows: rows.filter((r) => r.set === 'main' && r.reviewed).length,
    cards: res.cards,
    precision: res.precision,
    recall: res.recall,
    ambiguousRows: amb.length,
    ambiguousCards: ambRes.cards,
    unscored: missing.length,
  };
}

function printCheck(language: ClassifierLanguage) {
  const r = languageReadiness(evidenceFor(language), OPTS);
  const icon = { pass: '✅', fail: '❌', relaxed: '⚠️ prototype' };
  console.log(`\n### ${LANGUAGE_NAMES[language]} (${language}): ${r.ready ? (r.checks.some((c) => c.status === 'relaxed') ? 'READY (prototype)' : 'READY') : 'NOT READY'}`);
  for (const c of r.checks) console.log(`- ${icon[c.status]} ${c.name}: ${c.detail}`);
  return r.ready;
}

async function withConfig<T>(fn: (config: ConfigService, current: DeepPartial<SvsConfig>) => Promise<T>): Promise<T> {
  const url = flag('database-url') ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL or pass --database-url');
  const db = createDb(url)!;
  try {
    const config = new ConfigService(db, { reloadMs: 60000 });
    await config.load();
    const current = ((await db.query<{ overrides: DeepPartial<SvsConfig> }>('SELECT overrides FROM svs_config WHERE id = 1')).rows[0]?.overrides ?? {}) as DeepPartial<SvsConfig>;
    return await fn(config, current);
  } finally {
    await db.close();
  }
}

async function main() {
  if (cmd === 'check') {
    const langs = !arg || arg === 'all' ? CLASSIFIER_LANGUAGES.filter((l) => l !== 'other') : isLang(arg) ? [arg] : [];
    if (!langs.length) throw new Error(`unknown language ${arg}`);
    console.log(`Language readiness (${prototype ? 'PROTOTYPE rules: synthetic rows and draft copy accepted' : 'production rules'}; primary model ${configuredModels().primary})`);
    const ready = langs.map(printCheck);
    if (langs.length === 1 && !ready[0]) process.exitCode = 1;
  } else if (cmd === 'enable' || cmd === 'disable') {
    if (!isLang(arg)) throw new Error('give a language: ' + CLASSIFIER_LANGUAGES.filter((l) => l !== 'other').join(', '));
    const reason = flag('reason');
    if (!reason) throw new Error('--reason "…" is required (audit log)');
    if (cmd === 'enable' && !printCheck(arg)) throw new Error(`${arg} is not ready${prototype ? '' : ' (try --prototype for a prototype deployment)'}`);
    await withConfig(async (config, current) => {
      const now = config.get().classifier.languages;
      const next = cmd === 'enable' ? [...new Set([...now, arg])] : now.filter((l) => l !== arg);
      if (next.length === now.length && next.every((l, i) => l === now[i])) return console.log(`No change: classifier.languages = ${JSON.stringify(now)}`);
      const merged = { ...current, classifier: { ...(current.classifier ?? {}), languages: next } } as DeepPartial<SvsConfig>;
      const r = await config.setOverrides(merged, `ops-language${prototype ? ' (prototype)' : ''}`, reason);
      console.log(`✔ Config v${r.version}: classifier.languages = ${JSON.stringify(r.effective.classifier.languages)}; card copy languages = ${JSON.stringify(r.effective.copy.languages)}`);
    });
  } else if (cmd === 'rank') {
    // "Top 3 regional languages by segment usage": count learner messages by detected language (aggregates only).
    const days = Number(flag('days') ?? '30');
    const url = flag('database-url') ?? process.env.DATABASE_URL;
    if (!url) throw new Error('Set DATABASE_URL or pass --database-url');
    const db = createDb(url)!;
    {
      try {
        const { rows } = await db.query<{ content: string; user_id: string }>(
          `SELECT m.content, c.user_id FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN users u ON u.id = c.user_id
            WHERE m.role = 'user' AND m.created_at > now() - make_interval(days => $1) AND NOT u.is_test`,
          [days],
        );
        const msgs = new Map<string, number>();
        const users = new Map<string, Set<string>>();
        for (const r of rows) {
          const l = detectLanguage(r.content);
          msgs.set(l, (msgs.get(l) ?? 0) + 1);
          if (!users.has(l)) users.set(l, new Set());
          users.get(l)!.add(r.user_id);
        }
        console.log(`Learner messages in the last ${days} days by language (${rows.length} messages):`);
        for (const [l, n] of [...msgs].sort((a, b) => b[1] - a[1])) console.log(`  ${(LANGUAGE_NAMES[l as ClassifierLanguage] ?? l).padEnd(10)} ${String(n).padStart(7)} messages · ${users.get(l)!.size} users`);
        const regional = [...msgs].filter(([l]) => !['en', 'hinglish', 'hi', 'other'].includes(l)).sort((a, b) => b[1] - a[1]);
        console.log(`Regional languages by usage: ${regional.map(([l]) => l).join(', ') || '(none detected; the Census default bn, mr, te applies)'}`);
        console.log('Note: detection covers bn, mr, te today; other scripts count as "other" until a language is added.');
      } finally {
        await db.close();
      }
    }
  } else {
    console.log('Commands: check [<lang>|all] [--prototype] | enable <lang> [--prototype] --reason "…" | disable <lang> --reason "…" | rank [--days 30]');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`✖ ${(err as Error).message}`);
  process.exit(1);
});
