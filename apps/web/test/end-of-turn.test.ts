/** End-of-turn detection: how long after the learner stops talking does the turn end? */
import { describe, expect, it } from 'vitest';
import { EndOfTurnDetector } from '../src/lib/voice/end-of-turn';

const STEP = 50;

/** Feeds RMS levels (one per 50 ms) and returns the time the turn ended, or null. */
function run(levels: number[], opts: { silenceMs?: number; maxMs?: number; quiet?: boolean } = {}) {
  const d = new EndOfTurnDetector({ silenceMs: opts.silenceMs ?? 1800, maxMs: opts.maxMs ?? 60000, stepMs: STEP, quiet: opts.quiet });
  for (let i = 0; i < levels.length; i++) if (d.push(levels[i]!, i * STEP) === 'end') return { endedAt: i * STEP, hadSpeech: d.hadSpeech };
  return null;
}
const ms = (n: number, level: number) => Array<number>(n / STEP).fill(level);

describe('EndOfTurnDetector', () => {
  it('quiet room: the turn ends 1.8 s after the learner stops', () => {
    const r = run([...ms(300, 0.004), ...ms(4000, 0.12), ...ms(5000, 0.004)]);
    expect(r?.hadSpeech).toBe(true);
    expect(r!.endedAt).toBeGreaterThanOrEqual(4300 + 1700);
    expect(r!.endedAt).toBeLessThanOrEqual(4300 + 1900);
  });

  it('background noise that rises after calibration (fan, people nearby) no longer keeps the turn open', () => {
    // Calibrated in a quiet moment (0.004), then the room settles at 0.035: above the absolute threshold (0.015).
    // Before the fix this counted as speech forever and the turn only ended at the 60 s maximum.
    const r = run([...ms(300, 0.004), ...ms(4000, 0.14), ...ms(10000, 0.035)]);
    expect(r?.hadSpeech).toBe(true);
    expect(r!.endedAt).toBeLessThanOrEqual(4300 + 1900);
  });

  it('a short thinking pause (1 s) does not end the answer', () => {
    const r = run([...ms(300, 0.004), ...ms(3000, 0.12), ...ms(1000, 0.004), ...ms(3000, 0.12), ...ms(5000, 0.004)]);
    expect(r!.endedAt).toBeGreaterThanOrEqual(7300 + 1700);
  });

  it('soft speech still counts in quiet mode, and silence alone never ends a turn before the maximum', () => {
    expect(run([...ms(300, 0.003), ...ms(3000, 0.009), ...ms(4000, 0.003)], { quiet: true })?.hadSpeech).toBe(true);
    const none = run(ms(8000, 0.004), { maxMs: 6000 });
    expect(none).toEqual({ endedAt: 6000, hadSpeech: false });
  });
});
