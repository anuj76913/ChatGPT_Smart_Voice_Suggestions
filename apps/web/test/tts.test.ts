/**
 * Speaker watchdog timing. Bug: each sentence's watchdog started when it was QUEUED, so the last sentence of a
 * long coach reply "finished" while earlier sentences were still playing; the mic opened and recorded the coach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type U = { text: string; rate: number; onstart?: () => void; onend?: () => void; onerror?: () => void };

/** A fake speech engine that plays one utterance at a time, at 2 words per second. */
function installFakeEngine() {
  const queue: U[] = [];
  let playing: U | null = null;
  const next = () => {
    playing = queue.shift() ?? null;
    if (!playing) return;
    const u = playing;
    u.onstart?.();
    setTimeout(() => {
      playing = null;
      u.onend?.();
      next();
    }, (u.text.split(/\s+/).length / 2) * 1000);
  };
  const engine = {
    get speaking() {
      return playing !== null;
    },
    speak(u: U) {
      queue.push(u);
      if (!playing) next();
    },
    cancel() {
      queue.length = 0;
      playing = null;
    },
    getVoices: () => [],
    addEventListener() {},
  };
  vi.stubGlobal('window', { speechSynthesis: engine });
  vi.stubGlobal('speechSynthesis', engine);
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      rate = 1;
      volume = 1;
      lang = '';
      constructor(public text: string) {}
    },
  );
  return engine;
}

describe('Speaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeEngine();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a long reply: the speaker is not idle until the LAST sentence has really finished', async () => {
    const { Speaker } = await import('../src/lib/voice/tts');
    const s = new Speaker({ speed: 'normal', accent: 'en-IN', quiet: false } as never);
    const twenty = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '); // 10 s each at 2 words/s
    void s.speak(twenty);
    void s.speak(twenty);
    void s.speak('And three, a limited time free delivery incentive. Why do you think those would work?'); // ~7 s
    let idle = false;
    void s.idle().then(() => (idle = true));
    // 21 s in: sentences 1 and 2 are done, sentence 3 is playing. The old queue-time watchdog fired here.
    await vi.advanceTimersByTimeAsync(21000);
    expect(idle).toBe(false);
    await vi.advanceTimersByTimeAsync(7000);
    expect(idle).toBe(true);
  });

  it('settled() waits for the engine to stop and a grace period before the mic may open', async () => {
    const { Speaker } = await import('../src/lib/voice/tts');
    const s = new Speaker({ speed: 'normal', accent: 'en-IN', quiet: false } as never);
    void s.speak('one two three four'); // 2 s
    let ready = false;
    void s.settled(500).then(() => (ready = true));
    await vi.advanceTimersByTimeAsync(2200);
    expect(ready).toBe(false); // finished speaking, still inside the grace period
    await vi.advanceTimersByTimeAsync(500);
    expect(ready).toBe(true);
  });

  it('an engine that never starts still lets the session continue (watchdog)', async () => {
    vi.stubGlobal('speechSynthesis', { speaking: false, speak() {}, cancel() {}, getVoices: () => [], addEventListener() {} });
    const { Speaker } = await import('../src/lib/voice/tts');
    const s = new Speaker({ speed: 'normal', accent: 'en-IN', quiet: false } as never);
    let done = false;
    void s.speak('hello there').then(() => (done = true));
    await vi.advanceTimersByTimeAsync(7000);
    expect(done).toBe(true);
  });
});
