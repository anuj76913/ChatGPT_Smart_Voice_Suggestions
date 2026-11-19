/**
 * P10.1 ramp (no A/B in the prototype): step the rollout up only when the guardrails hold.
 *
 *   npm run ops:ramp -- status                  current step + the checks for the next one (50% or 100%)
 *   npm run ops:ramp -- to <pct> --reason "…"   step up if every check passes (warnings are allowed)
 *   npm run ops:ramp -- to <pct> --force --reason "…"   override failed checks (recorded in the audit log)
 *   Options: --database-url <url> (default DATABASE_URL), --dry-run
 *
 * A ramp step sets enabled = true, experiment = ramp.experimentId with treatment share 1 (everyone in the rollout gets
 * cards), and rolloutPercent = <pct>. Servers apply it within CONFIG_RELOAD_MS.
 */
import { config as loadDotenv } from 'dotenv';
import type { DeepPartial, SvsConfig } from '@svs/shared';
import { ConfigService } from '../apps/server/src/config/service';
import { createDb } from '../apps/server/src/db';
import { evaluateRamp } from '../apps/server/src/ops/ramp';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [cmd, pctArg] = positional;
const url = flag('database-url') ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL or pass --database-url');

const db = createDb(url)!;
try {
  const config = new ConfigService(db, { reloadMs: 60000 });
  await config.load();
  const cfg = config.get();
  const current = cfg.enabled ? cfg.rolloutPercent : 0;
  const target = cmd === 'to' ? Number(pctArg) : current < 50 ? 50 : 100;
  if (!['status', 'to'].includes(cmd ?? '')) {
    console.log('Commands: status | to <pct> [--force] --reason "…" [--dry-run]');
    process.exit(1);
  }
  const r = await evaluateRamp(db, cfg, target);
  const icon = { pass: '✅', warn: '⚠️', fail: '❌' } as const;
  console.log(`Ramp: ${current}% now (experiment ${cfg.experiment.id}, treatment share ${cfg.experiment.treatmentShare}) → ${target}%`);
  console.log(`Card languages: classifier ${JSON.stringify(cfg.classifier.languages)} · copy ${JSON.stringify(cfg.copy.languages)}\n`);
  for (const c of r.checks) console.log(`${icon[c.status]} ${c.name}: ${c.detail}`);
  console.log(`\n${r.allowed ? '✔ Step allowed.' : '✖ Step blocked by failed checks.'}`);
  if (cmd === 'to') {
    const reason = flag('reason');
    if (!reason) throw new Error('--reason "…" is required (audit log)');
    const force = args.includes('--force');
    if (!r.allowed && !force) process.exitCode = 1;
    else if (args.includes('--dry-run')) console.log('Dry run: config not changed.');
    else {
      const current = ((await db.query<{ overrides: DeepPartial<SvsConfig> }>('SELECT overrides FROM svs_config WHERE id = 1')).rows[0]?.overrides ?? {}) as DeepPartial<SvsConfig>;
      const next = { ...current, enabled: true, rolloutPercent: target, experiment: { id: cfg.ramp.experimentId, treatmentShare: 1 } } as DeepPartial<SvsConfig>;
      const failed = r.checks.filter((c) => c.status === 'fail').map((c) => c.name);
      const res = await config.setOverrides(next, `ops-ramp${force && failed.length ? ' (forced)' : ''}`, `${reason}${failed.length ? ` [forced past: ${failed.join('; ')}]` : ''}`);
      console.log(`✔ Config v${res.version}: rollout ${res.effective.rolloutPercent}%, experiment ${res.effective.experiment.id} (everyone in the rollout sees cards).`);
    }
  }
} catch (err) {
  console.error(`✖ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
