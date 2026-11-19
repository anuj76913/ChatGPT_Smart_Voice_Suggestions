import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CLASSIFIER_LANGUAGES, INTENT_LABELS } from '@svs/shared';

/** One labelled query (docs/phase0/labelling-guidelines.md §5). */
export const LabelledQuerySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only'),
    text: z.string().trim().min(1),
    language: z.enum(CLASSIFIER_LANGUAGES),
    label: z.enum(INTENT_LABELS),
    set: z.enum(['main', 'ambiguous']),
    source: z.enum(['synthetic_seed', 'survey', 'dogfood', 'manual']),
    labeler: z.string().min(1),
    reviewed: z.boolean(),
    notes: z.string().optional(),
  })
  .strict()
  .refine((q) => q.set !== 'ambiguous' || q.label === 'none', {
    message: 'ambiguous-set items must be labelled "none" (expected behaviour: no card)',
    path: ['label'],
  });

export type LabelledQuery = z.infer<typeof LabelledQuerySchema>;

export interface ParseResult {
  rows: LabelledQuery[];
  errors: string[];
}

export function readJsonl(path: string): ParseResult {
  const rows: LabelledQuery[] = [];
  const errors: string[] = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      errors.push(`line ${i + 1}: invalid JSON`);
      return;
    }
    const parsed = LabelledQuerySchema.safeParse(json);
    if (!parsed.success) {
      errors.push(`line ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      return;
    }
    rows.push(parsed.data);
  });
  return { rows, errors };
}

export const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
