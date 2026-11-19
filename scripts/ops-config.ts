/**
 * P7.7 ops CLI for the runbooks: change runtime config (S7) straight in the database, with validation and an audit
 * row, so it works even when the API is down. Every server picks the change up within CONFIG_RELOAD_MS (15 s).
 *
 *   npm run ops:config -- show
 *   npm run ops:config -- kill   [--region IN] [--language hi] [--cohort beta] --reason "…"   add a kill-switch rule
 *   npm run ops:config -- unkill [--region IN] [--language hi] [--cohort beta] --reason "…"   remove matching rule(s)
 *   npm run ops:config -- disable --reason "…" | enable --reason "…"                        svs.enabled
 *   npm run ops:config -- rollout <0-100> --reason "…"
 *   npm run ops:config -- model <chat|classifier|coach|opening|summary> <primary> [fallback|none] --reason "…"
 *   npm run ops:config -- merge '<json overrides>' --reason "…"                              any other change
 *   npm run ops:config -- preset dogfood-baseline [--dogfood-cohort dogfood] [--rollout 100] --reason "…"   Phase 8
 *   npm run ops:config -- preset ab-test [--rollout 10] --reason "…"                        Phase 9 (P8.5)
 *   npm run ops:config -- audit [--n 10]
 * Options: --database-url <url> (default DATABASE_URL), --actor <name> (default ops-cli:<os user>), --dry-run.
 */
import { userInfo } from 'node:os';
import { config as loadDotenv } from 'dotenv';
import { LLM_USE_CASES, type DeepPartial, type KillSwitchRule, type LlmUseCase, type SvsConfig } from '@svs/shared';
import { ConfigService, ConfigValidationError } from '../apps/server/src/config/service';
import { createDb } from '../apps/server/src/db';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [cmd, ...rest] = positional;
const url = flag('database-url') ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL or pass --database-url');
const actor = flag('actor') ?? `ops-cli:${userInfo().username}`;
const reason = flag('reason');
const dry = args.includes('--dry-run');

type Overrides = DeepPartial<SvsConfig>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const deepMerge = (a: unknown, b: unknown): unknown => {
  if (!isObj(a) || !isObj(b)) return b;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
  return out;
};

const db = createDb(url)!;
const config = new ConfigService(db, { reloadMs: 60000 });
try {
  await config.load();
  const cfg = config.get();
  const current = ((await db.query<{ overrides: Overrides }>('SELECT overrides FROM svs_config WHERE id = 1')).rows[0]?.overrides ?? {}) as Overrides;
  const rule = (): KillSwitchRule => {
    const r: KillSwitchRule = {};
    if (flag('region')) r.region = flag('region');
    if (flag('language')) r.language = flag('language');
    if (flag('cohort')) r.cohort = flag('cohort');
    if (!Object.keys(r).length) throw new Error('Give at least one of --region, --language, --cohort');
    return r;
  };
  const same = (a: KillSwitchRule, b: KillSwitchRule) => a.region === b.region && a.language === b.language && a.cohort === b.cohort;

  let change: Overrides | null = null;
  switch (cmd) {
    case 'show': {
      console.log(`Effective (key values): enabled=${cfg.enabled} rollout=${cfg.rolloutPercent}% dogfood=${JSON.stringify(cfg.dogfoodCohorts)} experiment=${cfg.experiment.id}@${cfg.experiment.treatmentShare}`);
      console.log(`Kill switch: ${cfg.killSwitch.length ? JSON.stringify(cfg.killSwitch) : 'none'}`);
      console.log(`Models: ${LLM_USE_CASES.map((u) => `${u}=${cfg.llm.models[u].primary}→${cfg.llm.models[u].fallback ?? '∅'}`).join(' ')} · stt=${cfg.stt.model}→${cfg.stt.fallbackModel}`);
      console.log(`Stored overrides: ${JSON.stringify(current, null, 2)}`);
      break;
    }
    case 'audit': {
      for (const a of await config.audit(Number(flag('n') ?? 10))) console.log(`v${a.version} ${new Date(a.changed_at).toISOString()} ${a.actor}: ${a.reason}`);
      break;
    }
    case 'kill': {
      const r = rule();
      if (cfg.killSwitch.some((k) => same(k, r))) console.log('That rule is already active.');
      else change = { killSwitch: [...cfg.killSwitch, r] };
      break;
    }
    case 'unkill': {
      const r = rule();
      const left = cfg.killSwitch.filter((k) => !same(k, r));
      if (left.length === cfg.killSwitch.length) console.log('No matching rule.');
      else change = { killSwitch: left };
      break;
    }
    case 'disable':
    case 'enable':
      change = { enabled: cmd === 'enable' };
      break;
    case 'rollout': {
      const pct = Number(rest[0]);
      if (!Number.isFinite(pct)) throw new Error('rollout needs a number 0–100');
      change = { rolloutPercent: pct };
      break;
    }
    case 'model': {
      const [useCase, primary, fallback] = rest;
      if (!LLM_USE_CASES.includes(useCase as LlmUseCase) || !primary) throw new Error(`model <${LLM_USE_CASES.join('|')}> <primary> [fallback|none]`);
      change = { llm: { models: { [useCase as LlmUseCase]: { primary, fallback: fallback === undefined ? cfg.llm.models[useCase as LlmUseCase].fallback : fallback === 'none' ? null : fallback } } } } as Overrides;
      break;
    }
    case 'merge':
      change = JSON.parse(rest[0] ?? '{}') as Overrides;
      break;
    case 'preset': {
      // Phase 8 (P8.1 + P8.4): dogfood cohort sees cards (treatment, outside any experiment); everyone else in the
      // rollout is in a baseline "experiment" with treatment share 0, so the classifier runs and eligibility is logged
      // (suggestion_eligible, arm = control) but nobody sees a card. That is the PRD's baseline pre-period.
      if (rest[0] === 'dogfood-baseline') {
        change = {
          enabled: true,
          rolloutPercent: Number(flag('rollout') ?? 100),
          dogfoodCohorts: [flag('dogfood-cohort') ?? 'dogfood'],
          experiment: { id: 'svs_baseline', treatmentShare: 0 },
        };
      } else if (rest[0] === 'ab-test') {
        // Phase 9 (frozen in P8.5): a fresh experiment id, so assignments start clean; 50/50 at 10% rollout.
        change = { enabled: true, rolloutPercent: Number(flag('rollout') ?? 10), experiment: { id: 'svs_v1', treatmentShare: 0.5 } };
      } else throw new Error('preset dogfood-baseline | ab-test');
      break;
    }
    default:
      console.log('Commands: show | audit | kill | unkill | disable | enable | rollout <pct> | model <use case> <primary> [fallback] | merge <json> | preset <dogfood-baseline|ab-test>  (see header)');
      process.exitCode = 1;
  }

  if (change) {
    if (!reason) throw new Error('--reason "…" is required for every change (it goes into the audit log)');
    const next = deepMerge(current, change) as Overrides;
    if (dry) console.log(`Dry run. Would set overrides to:\n${JSON.stringify(next, null, 2)}`);
    else {
      const r = await config.setOverrides(next, actor, reason);
      console.log(`✔ Config v${r.version} saved by ${actor}. Servers apply it within their reload interval (≤15 s by default).`);
      console.log(`  enabled=${r.effective.enabled} rollout=${r.effective.rolloutPercent}% kill switch=${JSON.stringify(r.effective.killSwitch)}`);
    }
  }
} catch (err) {
  if (err instanceof ConfigValidationError) console.error(`✖ Rejected, invalid config: ${JSON.stringify(err.issues)}`);
  else console.error(`✖ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
