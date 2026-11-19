/**
 * P6.6 power calculation for the A/B test (context.md §4.15: detect a 2 pp lift at 95% confidence, 80% power).
 *
 *   npm run analytics:power -- [--baselines 0.03,0.05,0.10,0.15,0.20] [--mde 0.02] [--alpha 0.05] [--power 0.8]
 *                              [--eligible-per-week 50000] [--rollout 0.10] [--weeks 4]
 *
 * Users per arm = two-proportion sample size (equal arms). With `--eligible-per-week`, it also reports whether a
 * `rollout` share of eligible users over `weeks` (split 50/50) reaches that size, and how long it would take.
 * Note: D7 retention has a smaller population (first-time voice users only), so it needs its own row.
 */
import { powerFor, sampleSizePerArm } from '../../apps/server/src/analytics/stats';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const baselines = opt('baselines', '0.03,0.05,0.10,0.15,0.20').split(',').map(Number);
const mde = Number(opt('mde', '0.02'));
const alpha = Number(opt('alpha', '0.05'));
const power = Number(opt('power', '0.8'));
const perWeek = opt('eligible-per-week', '');
const rollout = Number(opt('rollout', '0.10'));
const weeks = Number(opt('weeks', '4'));

console.log(`Two-sided test, alpha ${alpha}, power ${power}, minimum detectable lift +${(mde * 100).toFixed(1)} pp (absolute)\n`);
const head = ['Baseline', 'Treatment', 'Users per arm', 'Total users'];
if (perWeek) head.push(`Reached in ${weeks} wk at ${rollout * 100}%?`, 'Weeks needed', `Power after ${weeks} wk`);
console.log(`| ${head.join(' | ')} |`);
console.log(`|${head.map(() => '---').join('|')}|`);
for (const p1 of baselines) {
  const p2 = p1 + mde;
  const n = sampleSizePerArm(p1, p2, alpha, power);
  const cells = [`${(p1 * 100).toFixed(1)}%`, `${(p2 * 100).toFixed(1)}%`, n.toLocaleString('en-US'), (2 * n).toLocaleString('en-US')];
  if (perWeek) {
    const perArmPerWeek = (Number(perWeek) * rollout) / 2;
    const reached = perArmPerWeek * weeks;
    cells.push(reached >= n ? `yes (${Math.round(reached).toLocaleString('en-US')})` : `no (${Math.round(reached).toLocaleString('en-US')})`);
    cells.push((n / perArmPerWeek).toFixed(1));
    cells.push(`${(powerFor(p1, p2, Math.max(1, Math.floor(reached)), alpha) * 100).toFixed(0)}%`);
  }
  console.log(`| ${cells.join(' | ')} |`);
}
console.log('\nEligible users are counted once each (first eligibility); repeat visitors don\'t add sample.');
