/**
 * P8.2: masks obvious personal data in learner text before it is exported for labelling.
 * Covers emails, URLs, Indian phone numbers and long digit runs (roll numbers, IDs). Names can't be masked
 * reliably, so the labeller drops any row that still identifies someone.
 */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[url]')
    .replace(/(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g, '[phone]')
    .replace(/\b\d[\d\s-]{5,}\d\b/g, '[number]');
}

