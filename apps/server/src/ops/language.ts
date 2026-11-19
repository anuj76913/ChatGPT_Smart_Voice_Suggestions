import type { ClassifierLanguage } from '@svs/shared';

/**
 * P10.3 language readiness: may cards be shown for queries in this language? (PRD: "extend the classifier eval set to
 * cover them before enabling cards for those languages"; edge-case CL-06.)
 *
 * Production rule: card copy reviewed by a native speaker, ≥ minReviewedRows human-reviewed main-set eval rows in the
 * language, precision ≥ target on them, and no card on the language's ambiguous set.
 * Prototype rule (`--prototype`): the same precision and ambiguous-set checks, but synthetic / unreviewed rows and
 * draft copy are accepted (with a smaller minimum). Every relaxed check is reported as such, never hidden.
 */
export interface LanguageEvidence {
  language: ClassifierLanguage;
  /** null when the language reuses another language's copy (en, hinglish → English copy). */
  copyStatus: 'reviewed' | 'draft' | null;
  mainRows: number;
  reviewedMainRows: number;
  cards: number;
  precision: number | null;
  recall: number | null;
  ambiguousRows: number;
  ambiguousCards: number;
  /** Rows still missing a model prediction (eval not run on them yet). */
  unscored: number;
}

export interface ReadinessCheck {
  name: string;
  status: 'pass' | 'fail' | 'relaxed';
  detail: string;
}

export function languageReadiness(
  e: LanguageEvidence,
  opts: { precisionTarget: number; minReviewedRows: number; prototype: boolean; prototypeMinRows: number },
): { ready: boolean; checks: ReadinessCheck[] } {
  const checks: ReadinessCheck[] = [];
  const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

  if (e.copyStatus === null) checks.push({ name: 'Card copy', status: 'pass', detail: 'uses the English copy' });
  else if (e.copyStatus === 'reviewed') checks.push({ name: 'Card copy reviewed', status: 'pass', detail: 'native-speaker reviewed' });
  else checks.push({ name: 'Card copy reviewed', status: opts.prototype ? 'relaxed' : 'fail', detail: 'draft: needs native-speaker review (COPY_STATUS)' });

  const enoughReviewed = e.reviewedMainRows >= opts.minReviewedRows;
  if (enoughReviewed) checks.push({ name: `≥ ${opts.minReviewedRows} human-reviewed eval rows`, status: 'pass', detail: `${e.reviewedMainRows} reviewed` });
  else if (opts.prototype && e.mainRows >= opts.prototypeMinRows)
    checks.push({ name: `≥ ${opts.minReviewedRows} human-reviewed eval rows`, status: 'relaxed', detail: `${e.reviewedMainRows} reviewed; prototype accepts ${e.mainRows} synthetic rows (min ${opts.prototypeMinRows})` });
  else checks.push({ name: `≥ ${opts.minReviewedRows} human-reviewed eval rows`, status: 'fail', detail: `${e.reviewedMainRows} reviewed, ${e.mainRows} rows in total` });

  checks.push({ name: 'Eval scored', status: e.unscored === 0 ? 'pass' : 'fail', detail: e.unscored ? `${e.unscored} rows without a prediction: run npm run eval:classifier` : 'all rows scored' });

  const precisionOk = e.precision !== null && e.precision >= opts.precisionTarget && e.cards > 0;
  checks.push({
    name: `Precision ≥ ${pct(opts.precisionTarget)}`,
    status: precisionOk ? 'pass' : 'fail',
    detail: `${pct(e.precision)} on ${e.cards} cards (recall ${pct(e.recall)})`,
  });
  checks.push({
    name: 'No cards on the ambiguous set',
    status: e.ambiguousRows > 0 && e.ambiguousCards === 0 ? 'pass' : 'fail',
    detail: e.ambiguousRows ? `${e.ambiguousCards} of ${e.ambiguousRows} ambiguous rows got a card` : 'no ambiguous rows in this language',
  });
  return { ready: checks.every((c) => c.status !== 'fail'), checks };
}
