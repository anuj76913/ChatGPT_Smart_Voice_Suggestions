/**
 * Records one spoken turn (decisions.md ADR-005): MediaRecorder + a simple energy-based voice-activity detector.
 * The turn ends after `silenceMs` of quiet following speech (1.8 s; quiet is measured against the learner's own level), on `stop()` (the "Done" button), or at `maxMs`.
 * Audio stays in memory and is sent once to the server; nothing is saved on the device.
 */
import { EndOfTurnDetector } from './end-of-turn';

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export interface TurnResult {
  blob: Blob;
  mime: string;
  hadSpeech: boolean;
}

export class TurnRecorder {
  /** Phase 11 quiet / whisper mode: a lower speech threshold, so soft speech still counts. */
  quiet = false;
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private source: MediaStreamAudioSourceNode;
  private rec: MediaRecorder | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private finish: ((r: TurnResult | null) => void) | null = null;
  private cancelled = false;

  constructor(
    private readonly stream: MediaStream,
    private readonly opts: { silenceMs: number; maxMs: number; onSpeechStart?: () => void; onLevel?: (level: number) => void },
  ) {
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
  }

  get recording() {
    return this.rec?.state === 'recording';
  }

  /** Starts a turn. Resolves with the clip, or null if cancelled. */
  start(): Promise<TurnResult | null> {
    // A mic that was unplugged, revoked or taken by another app can't record; say so instead of hanging.
    if (this.stream.getAudioTracks().every((t) => t.readyState === 'ended')) throw new Error('microphone_ended');
    if (this.recording) this.cancel();
    this.cancelled = false;
    void this.ctx.resume();
    const mime = pickMime();
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.rec = rec;
    const chunks: Blob[] = [];
    let hadSpeech = false;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const result = new Promise<TurnResult | null>((resolve) => {
      this.finish = resolve;
      rec.onstop = () => {
        clearInterval(this.timer);
        const done = this.finish;
        this.finish = null;
        done?.(this.cancelled ? null : { blob: new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }), mime: rec.mimeType || mime || 'audio/webm', hadSpeech });
      };
    });
    rec.start(250);

    // End of turn: noise-floor calibration, then silence relative to the learner's own speech level (end-of-turn.ts).
    const buf = new Float32Array(this.analyser.fftSize);
    const started = Date.now();
    const STEP = 50;
    const detector = new EndOfTurnDetector({ silenceMs: this.opts.silenceMs, maxMs: this.opts.maxMs, stepMs: STEP, quiet: this.quiet });
    this.timer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      const rms = Math.sqrt(sum / buf.length);
      this.opts.onLevel?.(rms);
      const signal = detector.push(rms, Date.now() - started);
      if (signal === 'speech-start') {
        hadSpeech = true;
        this.opts.onSpeechStart?.();
      } else if (signal === 'end') {
        hadSpeech = detector.hadSpeech;
        this.stop();
      }
    }, STEP);
    return result;
  }

  /** Ends the turn now and sends what was recorded ("Done"). */
  stop() {
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
  }

  /** Discards the current turn (pause, end, speaking). */
  cancel() {
    this.cancelled = true;
    this.stop();
  }

  dispose() {
    this.cancel();
    clearInterval(this.timer);
    this.source.disconnect();
    void this.ctx.close();
  }
}
