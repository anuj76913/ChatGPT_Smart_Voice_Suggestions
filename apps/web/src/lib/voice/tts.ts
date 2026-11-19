import type { VoiceSettings } from '@svs/shared';

/**
 * Browser text-to-speech (decisions.md ADR-005): speechSynthesis with an en-IN or hi-IN voice.
 * Speed = utterance.rate; "accent" = which voice. Devanagari text always prefers a Hindi voice.
 * If no matching voice exists the browser default is used, and captions always show the text (AX-03, SP-03).
 */
const RATE: Record<VoiceSettings['speed'], number> = { slow: 0.85, normal: 1, fast: 1.2 };
const DEVANAGARI = /[ऀ-ॿ]/;
const BENGALI = /[ঀ-৿]/;
const TELUGU = /[ఀ-౿]/;

/**
 * Voice locale for a sentence by its script (Phase 10). Devanagari tries a Hindi voice first, then Marathi (Marathi
 * voices are rare on phones). With no matching voice, the browser falls back and captions carry the text.
 */
export function localesFor(text: string, accent: VoiceSettings['accent']): string[] {
  if (BENGALI.test(text)) return ['bn-IN', 'bn-BD'];
  if (TELUGU.test(text)) return ['te-IN'];
  if (DEVANAGARI.test(text)) return ['hi-IN', 'mr-IN'];
  return [accent];
}

export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

let voices: SpeechSynthesisVoice[] = [];
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!ttsSupported()) return Promise.resolve([]);
  voices = speechSynthesis.getVoices();
  if (voices.length) return Promise.resolve(voices);
  return new Promise((resolve) => {
    const done = () => {
      voices = speechSynthesis.getVoices();
      resolve(voices);
    };
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

export function pickVoice(text: string, accent: VoiceSettings['accent']): SpeechSynthesisVoice | null {
  const wanted = localesFor(text, accent);
  const by = (lang: string) => voices.find((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase());
  for (const l of wanted) {
    const v = by(l);
    if (v) return v;
  }
  // Latin text: any English voice. Indic text without its voice: let the browser pick from u.lang.
  return wanted[0] === accent ? (by('en-IN') ?? voices.find((v) => v.lang.toLowerCase().startsWith('en')) ?? null) : null;
}

export const hasHindiVoice = () => voices.some((v) => v.lang.replace('_', '-').toLowerCase() === 'hi-in');

/** Speaks sentences in order. `speak` resolves when that sentence has finished (or failed). */
export class Speaker {
  private settings: VoiceSettings;
  private pending = 0;
  /** Estimated playing time of everything queued (for the never-started watchdog). */
  private queuedMs = 0;
  private idleWaiters: Array<() => void> = [];
  private firstStart: (() => void) | null;

  constructor(settings: VoiceSettings, onFirstAudio?: () => void) {
    this.settings = settings;
    this.firstStart = onFirstAudio ?? null;
  }

  setSettings(s: VoiceSettings) {
    this.settings = s;
  }

  get busy() {
    return this.pending > 0;
  }

  speak(text: string): Promise<void> {
    if (!ttsSupported() || !text.trim()) {
      this.firstStart?.();
      this.firstStart = null;
      return Promise.resolve();
    }
    this.pending++;
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice(text, this.settings.accent);
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      } else u.lang = localesFor(text, this.settings.accent)[0]!;
      u.rate = RATE[this.settings.speed];
      // Phase 11 quiet mode: softer playback (headphones recommended).
      u.volume = this.settings.quiet ? 0.55 : 1;
      let done = false;
      // Watchdog (bug bash, P7.8): some engines never fire end/error (no voice installed, Chrome's long-utterance
      // bug, a backgrounded tab). Without it the session would stay on "Speaking" and never listen again.
      // Budget: ~2 words/s at rate 1 (Indian English voices are slower than 2.5), scaled by the rate, plus 3 s.
      // The duration timer starts when the sentence STARTS playing, not when it is queued: armed at queue time,
      // the last sentence of a long reply timed out while earlier ones were still playing, the mic opened while
      // the coach was still talking, and the coach's own voice was transcribed as the learner's answer.
      const words = text.trim().split(/\s+/).length;
      const estimateMs = (words / (2 * u.rate)) * 1000 + 3000;
      const aheadMs = this.queuedMs;
      this.queuedMs += estimateMs;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      // Never started at all (engine stuck): give up once everything ahead of it should have finished.
      const startWatch = setTimeout(() => finish(), aheadMs + estimateMs + 2000);
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(startWatch);
        clearTimeout(watchdog);
        this.queuedMs = Math.max(0, this.queuedMs - estimateMs);
        this.pending = Math.max(0, this.pending - 1);
        resolve();
        if (this.pending === 0) this.idleWaiters.splice(0).forEach((w) => w());
      };
      u.onstart = () => {
        clearTimeout(startWatch);
        watchdog = setTimeout(finish, estimateMs);
        this.firstStart?.();
        this.firstStart = null;
      };
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
    });
  }

  /** Resolves once everything queued has been spoken. */
  idle(): Promise<void> {
    return this.pending === 0 ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r));
  }

  /**
   * Resolves when it is safe to open the mic: everything queued is done, the browser reports it is no longer
   * speaking (catches a watchdog that fired early), and a short grace period has passed for the speaker's tail
   * and room echo. Capped so a stuck engine can't block listening forever.
   */
  async settled(graceMs = 500, capMs = 20000): Promise<void> {
    await this.idle();
    const until = Date.now() + capMs;
    while (ttsSupported() && speechSynthesis.speaking && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, graceMs));
  }

  cancel() {
    if (ttsSupported()) speechSynthesis.cancel();
    this.pending = 0;
    this.queuedMs = 0;
    this.idleWaiters.splice(0).forEach((w) => w());
  }
}
