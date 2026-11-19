/**
 * Echo guard: browser text-to-speech is not covered by the mic's echo cancellation, so on laptop speakers the
 * mic can pick up the coach's own voice, and Whisper returns the coach's last sentence as the "learner's answer".
 * A transcript is treated as echo when a long run of its words appears, in order, in the coach's last reply.
 * A real answer that quotes the question ("why would those work? because…") keeps most of its words outside
 * the run, so it is not discarded.
 */
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Longest run of consecutive words shared by both texts. */
function longestSharedRun(a: string[], b: string[]): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1]! + 1;
        if (cur[j]! > best) best = cur[j]!;
      }
    }
    prev = cur;
  }
  return best;
}

export function isCoachEcho(transcript: string, coachReply: string | undefined): boolean {
  if (!coachReply) return false;
  const t = norm(transcript);
  if (t.length < 3) return false;
  const run = longestSharedRun(t, norm(coachReply));
  return run >= 4 && run >= Math.ceil(t.length * 0.6);
}
