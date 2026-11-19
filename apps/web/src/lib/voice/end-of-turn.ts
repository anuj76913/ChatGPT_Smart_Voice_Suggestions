/**
 * End-of-turn detection for one spoken answer, fed one RMS level every `stepMs` (pure, so it can be unit-tested).
 *
 * 1. The first 300 ms calibrate the room's noise floor; speech is anything clearly above it.
 * 2. Once the learner has spoken, "silence" is measured RELATIVE to their own speaking level: a frame counts as
 *    silence when it falls below 35% of their average speech level (or the absolute threshold, if higher).
 *    Before this, any background noise that rose after calibration (a fan, people nearby) counted as speech,
 *    the silence timer kept resetting, and the turn only ended at the maximum length: a long wait after the
 *    learner had finished.
 * 3. The turn ends after `silenceMs` of continuous silence following speech, or at `maxMs`.
 */
export type TurnSignal = 'continue' | 'speech-start' | 'end';

export class EndOfTurnDetector {
  hadSpeech = false;
  private floor = 0.005;
  private floorSamples = 0;
  private speechMs = 0;
  private silentMs = 0;
  /** Running average of the learner's speech level (RMS of speech frames). */
  private speechLevel = 0;

  constructor(private readonly o: { silenceMs: number; maxMs: number; stepMs: number; quiet?: boolean }) {}

  /** Absolute speech threshold from the calibrated floor (lower in quiet / whisper mode). */
  private get threshold() {
    return this.o.quiet ? Math.max(0.006, this.floor * 1.6) : Math.max(0.015, this.floor * 2.5);
  }

  push(rms: number, elapsedMs: number): TurnSignal {
    if (elapsedMs < 300) {
      this.floor = (this.floor * this.floorSamples + rms) / ++this.floorSamples;
      return 'continue';
    }
    const cut = this.hadSpeech ? Math.max(this.threshold, this.speechLevel * 0.35) : this.threshold;
    let signal: TurnSignal = 'continue';
    if (rms > cut) {
      this.speechMs += this.o.stepMs;
      this.silentMs = 0;
      this.speechLevel = this.speechLevel === 0 ? rms : this.speechLevel * 0.9 + rms * 0.1;
      if (!this.hadSpeech && this.speechMs >= 150) {
        this.hadSpeech = true;
        signal = 'speech-start';
      }
    } else if (this.hadSpeech) this.silentMs += this.o.stepMs;
    if ((this.hadSpeech && this.silentMs >= this.o.silenceMs) || elapsedMs >= this.o.maxMs) return 'end';
    return signal;
  }
}
