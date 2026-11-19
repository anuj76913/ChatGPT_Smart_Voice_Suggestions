/**
 * Source rules that unit tests can't otherwise catch (bug bash P7.8).
 * BB-01: an effect written as `useEffect(() => expr, deps)` returns expr. If that's a Promise (Chrome's
 * scrollIntoView() now returns one), React calls it as the cleanup and the screen crashes. Effects use block bodies.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** `useEffect(() =>` followed by anything other than `{`, `() =>` (a cleanup factory) or a line break. */
const EXPRESSION_EFFECT = /use(Layout)?Effect\(\s*(async\s*)?\(\)\s*=>(?!\s*(\{|\(\)\s*=>|$))/;

describe('web source rules', () => {
  it('effects never return a value by accident (block bodies only)', () => {
    const offenders = files(SRC).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((text, i) => ({ where: `${f}:${i + 1}`, text: text.trimEnd() }))
        .filter((l) => EXPRESSION_EFFECT.test(l.text)),
    );
    expect(offenders.map((o) => o.where)).toEqual([]);
  });

  it('the rule catches the BB-01 pattern', () => {
    expect(EXPRESSION_EFFECT.test("useEffect(() => ref.current?.scrollIntoView({ block: 'end' }), [x]);")).toBe(true);
    expect(EXPRESSION_EFFECT.test('useEffect(async () => { await x(); }, []);')).toBe(false); // block body (async is still wrong, but rare)
    expect(EXPRESSION_EFFECT.test('useEffect(() => {')).toBe(false);
    expect(EXPRESSION_EFFECT.test('    () => () => {')).toBe(false);
  });
});
