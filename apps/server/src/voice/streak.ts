/**
 * P5.3 streak: consecutive local days with ≥1 qualifying session (≥30 s on a learning task), against a goal.
 * A session counts on the local day it STARTED (edge-case SU-07), in the user's time zone at that moment (TM-03/04).
 * Pure functions on ISO day strings (YYYY-MM-DD), so time-zone logic is testable without a clock.
 */

/** The local calendar day of an instant in a time zone, as YYYY-MM-DD. Falls back to Asia/Kolkata on a bad zone. */
export function localDay(at: Date, timeZone: string): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  try {
    return fmt(timeZone);
  } catch {
    return fmt('Asia/Kolkata');
  }
}

export function dayBefore(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface StreakState {
  current: number;
  lastDay: string | null;
}

/** Streak after a qualifying session on `day`: same day → unchanged, next day → +1, gap → 1 (edge-cases SU-06, SU-08). */
export function creditDay(prev: StreakState, day: string): StreakState {
  if (prev.lastDay === day) return { current: Math.max(1, prev.current), lastDay: day };
  if (prev.lastDay && day < prev.lastDay) return prev; // late-arriving older session never rewinds the streak
  if (prev.lastDay === dayBefore(day)) return { current: prev.current + 1, lastDay: day };
  return { current: 1, lastDay: day };
}

/** The streak to show today: still alive if the last qualifying day was today or yesterday, otherwise 0. */
export function visibleStreak(s: StreakState, today: string): number {
  return s.lastDay === today || s.lastDay === dayBefore(today) ? s.current : 0;
}
