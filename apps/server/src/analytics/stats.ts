/**
 * Small, dependency-free statistics for the experiment (P6.5–P6.7). All tests are two-sided.
 * Accuracy: the normal CDF uses a rational approximation of erf (|error| < 1.5e-7), enough for p-values and power.
 */
import type { ArmComparison, Proportion, SrmResult } from '@svs/shared';

export function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

export const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Inverse normal CDF (Acklam's algorithm, relative error < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError('p must be in (0, 1)');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export const proportion = (num: number, den: number): Proportion => ({ num, den, rate: den > 0 ? num / den : null });

/** Two-proportion z-test (pooled SE for the test, unpooled SE for the 95% CI of the difference). */
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number): { diff: number; z: number; p: number; ci95: [number, number] } | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const diff = p2 - p1;
  const z = se > 0 ? diff / se : 0;
  const p = se > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1;
  const seU = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return { diff, z, p, ci95: [diff - 1.959964 * seU, diff + 1.959964 * seU] };
}

/** control vs treatment as an ArmComparison (diff = treatment − control). */
export function compareArms(control: Proportion, treatment: Proportion): ArmComparison {
  const t = twoProportionTest(control.num, control.den, treatment.num, treatment.den);
  return { control, treatment, diff: t?.diff ?? null, ci95: t?.ci95 ?? null, p_value: t?.p ?? null };
}

/** Sample-ratio mismatch: chi-square goodness of fit (df = 1) of the observed split vs the configured share. */
export function srm(control: number, treatment: number, expectedTreatmentShare: number, alpha: number): SrmResult {
  const n = control + treatment;
  if (n === 0 || expectedTreatmentShare <= 0 || expectedTreatmentShare >= 1)
    return { control, treatment, expected_treatment_share: expectedTreatmentShare, chi2: null, p_value: null, mismatch: false };
  const eT = n * expectedTreatmentShare;
  const eC = n - eT;
  const chi2 = (treatment - eT) ** 2 / eT + (control - eC) ** 2 / eC;
  const p = 2 * (1 - normalCdf(Math.sqrt(chi2))); // chi-square df=1 survival = P(|Z| > sqrt(chi2))
  return { control, treatment, expected_treatment_share: expectedTreatmentShare, chi2, p_value: p, mismatch: p < alpha };
}

/**
 * Users per arm to detect p1 → p2 with a two-sided test at `alpha` and `power` (equal arms).
 * n = (z_{1-α/2}·√(2·p̄·(1−p̄)) + z_{power}·√(p1(1−p1) + p2(1−p2)))² / (p2 − p1)²
 */
export function sampleSizePerArm(p1: number, p2: number, alpha = 0.05, power = 0.8): number {
  if (p1 === p2) return Infinity;
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const pbar = (p1 + p2) / 2;
  const n = (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p2 - p1) ** 2;
  return Math.ceil(n);
}

/** Power of the two-sided test with n users per arm. */
export function powerFor(p1: number, p2: number, nPerArm: number, alpha = 0.05): number {
  const za = normalQuantile(1 - alpha / 2);
  const pbar = (p1 + p2) / 2;
  const se0 = Math.sqrt((2 * pbar * (1 - pbar)) / nPerArm);
  const se1 = Math.sqrt((p1 * (1 - p1) + p2 * (1 - p2)) / nPerArm);
  return normalCdf((Math.abs(p2 - p1) - za * se0) / se1);
}

/** Linear-interpolated percentile (q in [0, 1]) of an unsorted list; null when empty. */
export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
