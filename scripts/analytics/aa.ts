/**
 * P6.5 synthetic A/A validation of the experiment machinery (no database needed):
 *   1. split    200k random user ids → the configured share, no sample-ratio mismatch (SRM)
 *   2. stable   the same user always gets the same arm (assignment is a pure hash of user + experiment)
 *   3. independent  arms of two experiments are uncorrelated (no carry-over between experiments)
 *   4. A/A false positives  2,000 simulated A/A tests with no real effect: the two-proportion test fires at ≈ alpha
 *      (5%), and the SRM alarm at ≈ its p threshold
 *
 *   npm run analytics:aa -- [--users 200000] [--sims 2000] [--seed 11]
 * Exits non-zero if any check fails, so it can run in CI.
 */
import { DEFAULT_SVS_CONFIG, mergeConfig } from '@svs/shared';
import { erf, srm, twoProportionTest } from '../../apps/server/src/analytics/stats';
import { armFor } from '../../apps/server/src/suggestions/experiment';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const USERS = Number(opt('users', '200000'));
const SIMS = Number(opt('sims', '2000'));
let state = Number(opt('seed', '11')) >>> 0 || 1;
const rnd = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const uuid = () => {
  const h = Array.from({ length: 32 }, () => Math.floor(rnd() * 16).toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
};

const cfg = DEFAULT_SVS_CONFIG;
const alphaSrm = cfg.analytics.srmPValue;
let failed = 0;
const report = (ok: boolean, name: string, detail: string) => {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}: ${detail}`);
};

// 1. Split
const ids = Array.from({ length: USERS }, uuid);
const arms = ids.map((id) => armFor(id, cfg));
const t = arms.filter((a) => a === 'treatment').length;
const s = srm(USERS - t, t, cfg.experiment.treatmentShare, alphaSrm);
report(!s.mismatch, 'Split', `${t.toLocaleString('en-US')} treatment / ${(USERS - t).toLocaleString('en-US')} control (${((t / USERS) * 100).toFixed(2)}% vs ${cfg.experiment.treatmentShare * 100}%), SRM p=${s.p_value!.toFixed(3)}`);

// Other shares work too (e.g. a 10/90 holdout).
const cfg10 = mergeConfig(cfg, { experiment: { id: cfg.experiment.id, treatmentShare: 0.1 } });
const t10 = ids.filter((id) => armFor(id, cfg10) === 'treatment').length;
const s10 = srm(USERS - t10, t10, 0.1, alphaSrm);
report(!s10.mismatch, 'Split at 10%', `${((t10 / USERS) * 100).toFixed(2)}% treatment, SRM p=${s10.p_value!.toFixed(3)}`);

// 2. Stability
const stable = ids.slice(0, 10000).every((id, i) => armFor(id, cfg) === arms[i] && armFor(id, cfg) === armFor(id, mergeConfig(cfg, {})));
report(stable, 'Stable', 'the same user gets the same arm on every call (any device, any server)');

// 3. Independence between experiments (2x2 chi-square via SRM-style test on agreement)
const other = mergeConfig(cfg, { experiment: { id: 'svs_aa_check', treatmentShare: 0.5 } });
let both = 0;
let onlyA = 0;
let onlyB = 0;
let none = 0;
ids.forEach((id, i) => {
  const a = arms[i] === 'treatment';
  const b = armFor(id, other) === 'treatment';
  if (a && b) both++;
  else if (a) onlyA++;
  else if (b) onlyB++;
  else none++;
});
const n = USERS;
const expected = [((both + onlyA) * (both + onlyB)) / n, ((both + onlyA) * (onlyA + none)) / n, ((onlyB + none) * (both + onlyB)) / n, ((onlyB + none) * (onlyA + none)) / n];
const chi2 = [both, onlyA, onlyB, none].reduce((acc, o, i) => acc + (o - expected[i]!) ** 2 / expected[i]!, 0);
const pInd = 2 * (1 - 0.5 * (1 + erf(Math.sqrt(chi2) / Math.SQRT2)));
report(pInd > 0.001, 'Independent experiments', `svs_v1 × svs_aa_check agreement chi2=${chi2.toFixed(2)}, p=${pInd.toFixed(3)}`);

// 4. Simulated A/A tests: no true effect, so p < 0.05 should happen ~5% of the time.
let falsePos = 0;
let srmAlarms = 0;
const perSim = 4000;
for (let k = 0; k < SIMS; k++) {
  const c = mergeConfig(cfg, { experiment: { id: `aa_${k}`, treatmentShare: 0.5 } });
  let nt = 0;
  let nc = 0;
  let xt = 0;
  let xc = 0;
  for (let j = 0; j < perSim; j++) {
    const outcome = rnd() < 0.1; // same 10% base rate in both arms
    if (armFor(ids[(k * 7919 + j) % USERS]!, c) === 'treatment') {
      nt++;
      if (outcome) xt++;
    } else {
      nc++;
      if (outcome) xc++;
    }
  }
  if ((twoProportionTest(xc, nc, xt, nt)?.p ?? 1) < 0.05) falsePos++;
  if (srm(nc, nt, 0.5, alphaSrm).mismatch) srmAlarms++;
}
const fpr = falsePos / SIMS;
const se = Math.sqrt((0.05 * 0.95) / SIMS);
report(Math.abs(fpr - 0.05) < 3 * se, 'A/A false-positive rate', `${(fpr * 100).toFixed(2)}% of ${SIMS} A/A tests had p < 0.05 (expected 5% ± ${(3 * se * 100).toFixed(2)})`);
report(srmAlarms / SIMS <= alphaSrm * 5 + 3 / SIMS, 'SRM false alarms', `${srmAlarms} of ${SIMS} (expected ≈ ${(alphaSrm * SIMS).toFixed(1)})`);

console.log(failed ? `\n✖ ${failed} check(s) failed` : '\n✔ A/A validation passed');
process.exit(failed ? 1 : 0);

