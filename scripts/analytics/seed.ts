/**
 * Synthetic "staging" data for Phase 6: users, experiment assignments, chats, suggestions, voice sessions,
 * events and Groq usage, shaped like real traffic, so every metric, the dashboard and the analysis can be exercised.
 *
 *   npm run analytics:seed -- [--scenario ship|iterate|kill|aa|baseline] [--users 4000] [--days 42] [--seed 7]
 *                             [--database-url postgres://…/svs_analytics]
 *
 * Default target: a separate `svs_analytics` database next to DATABASE_URL (created and migrated if missing), so the
 * dev database stays clean. Re-running replaces the previous synthetic data. Everything is deterministic for a seed.
 * Synthetic users have cohort "synthetic" and handles "syn_…"; no real content is generated.
 */
import { config as loadDotenv } from 'dotenv';
import { DEFAULT_SVS_CONFIG, mergeConfig, PRESET_BY_INTENT, VOICE_INTENTS, type VoiceIntent } from '@svs/shared';
import { createDb, type Db } from '../../apps/server/src/db';
import { runMigrations } from '../../apps/server/src/migrate';
import { armFor } from '../../apps/server/src/suggestions/experiment';
import { analyticsDatabaseUrl, describeUrl } from './target';

loadDotenv({ quiet: true });

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
/** baseline = the Phase 8 pre-period: experiment svs_baseline, everyone control, no cards, voice only via the mic button. */
type Scenario = 'ship' | 'iterate' | 'kill' | 'aa' | 'baseline';
const scenario = opt('scenario', 'ship') as Scenario;
if (!['ship', 'iterate', 'kill', 'aa', 'baseline'].includes(scenario)) throw new Error(`unknown scenario ${scenario}`);
const USERS = Number(opt('users', '4000'));
const DAYS = Number(opt('days', '42'));
const SEED = Number(opt('seed', '7'));

/** Behaviour per arm. Rates are per eligible card or per user, as noted. */
const P = {
  eligibleUser: 0.6, // share of users who send ≥1 eligible query
  shownVisible: 0.95, // card actually seen
  tap: scenario === 'aa' ? 0 : 0.3, // per shown card
  micOk: 0.9, // per tap
  startAfterMic: 0.92,
  qualifies: 0.72, // session ≥30 s
  organicStartPerUser: 0.05, // voice without a card (mic button / habit), both arms
  retention: { control: 0.2, treatment: scenario === 'ship' ? 0.3 : scenario === 'aa' ? 0.2 : 0.21 },
  optOut: scenario === 'kill' ? 0.09 : 0.02, // per treatment user shown a card
  feedback: 0.3, // answers that get a vote
  thumbsDown: { control: 0.08, treatment: scenario === 'kill' ? 0.13 : 0.08 },
  d30: 0.35,
};

// ---------- deterministic randomness ----------
let state = SEED >>> 0 || 1;
const rnd = () => {
  // mulberry32
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const chance = (p: number) => rnd() < p;
const pick = <T>(xs: readonly T[], weights?: number[]) => {
  if (!weights) return xs[Math.floor(rnd() * xs.length)]!;
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < xs.length; i++) if ((r -= weights[i]!) < 0) return xs[i]!;
  return xs[xs.length - 1]!;
};
const between = (a: number, b: number) => a + rnd() * (b - a);
const uuid = () => {
  const h = Array.from({ length: 32 }, () => Math.floor(rnd() * 16).toString(16));
  h[12] = '4';
  h[16] = '89ab'[Math.floor(rnd() * 4)]!;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};

// ---------- rows ----------
const now = Date.now();
const DAY = 86_400_000;
const iso = (t: number) => new Date(Math.min(t, now - 1000)).toISOString();
type Row = unknown[];
const rows = {
  users: [] as Row[],
  experiment_assignments: [] as Row[],
  conversations: [] as Row[],
  messages: [] as Row[],
  suggestions: [] as Row[],
  suggestion_decisions: [] as Row[],
  voice_sessions: [] as Row[],
  events: [] as Row[],
  llm_usage: [] as Row[],
};
const COLS: Record<string, string[]> = {
  users: ['id', 'handle', 'display_name', 'region', 'tier', 'cohort', 'timezone', 'is_test', 'created_at'],
  experiment_assignments: ['user_id', 'experiment_id', 'arm', 'assigned_at'],
  conversations: ['id', 'user_id', 'created_at', 'updated_at'],
  messages: ['id', 'conversation_id', 'role', 'content', 'reply_to', 'created_at'],
  suggestions: ['id', 'message_id', 'conversation_id', 'user_id', 'intent', 'confidence', 'language', 'arm', 'status', 'evaluated_at'],
  suggestion_decisions: ['at', 'user_id', 'conversation_id', 'message_id', 'outcome', 'arm', 'intent', 'confidence', 'language', 'classifier_stage', 'classifier_ms', 'decision_ms'],
  voice_sessions: ['id', 'user_id', 'conversation_id', 'suggestion_id', 'preset_id', 'entry_point', 'status', 'started_at', 'ended_at', 'end_reason', 'dominant_language', 'qualifies_for_wavl', 'start_latency_ms', 'duration_s', 'questions_practised', 'user_turns', 'intent', 'language'],
  events: ['event_id', 'event', 'ts', 'source', 'user_id', 'session_id', 'experiment_id', 'arm', 'cohort', 'intent_type', 'language', 'app_version', 'platform', 'props'],
  llm_usage: ['at', 'use_case', 'model', 'status', 'error_kind', 'fallback_used', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'latency_ms', 'ttft_ms', 'user_id', 'voice_session_id', 'audio_seconds'],
};

const cfg = scenario === 'baseline' ? mergeConfig(DEFAULT_SVS_CONFIG, { experiment: { id: 'svs_baseline', treatmentShare: 0 } }) : DEFAULT_SVS_CONFIG;
const EXP = cfg.experiment.id;

function event(name: string, t: number, userId: string, arm: string | null, intent: string | null, language: string | null, props: Record<string, unknown>, source = 'client') {
  rows.events.push([uuid(), name, iso(t), source, userId, 'syn', arm ? EXP : null, arm, 'synthetic', intent, language, source === 'server' ? 'server' : 'synthetic', source === 'server' ? null : 'web-mobile', JSON.stringify(props)]);
}

function usage(t: number, useCase: string, model: string, userId: string, pin: number, pout: number, latency: number, opts: { ttft?: number; vsid?: string; audio?: number } = {}) {
  const rateLimited = chance(0.01);
  rows.llm_usage.push([
    iso(t),
    useCase,
    model,
    rateLimited ? 'error' : 'ok',
    rateLimited ? 'rate_limited' : null,
    false,
    rateLimited ? null : pin,
    rateLimited ? null : pout,
    rateLimited ? null : pin + pout,
    Math.round(latency),
    opts.ttft ? Math.round(opts.ttft) : null,
    userId,
    opts.vsid ?? null,
    opts.audio ?? null,
  ]);
}

/** One voice session (started at t). Returns its start time. */
function voiceSession(userId: string, arm: string, intent: VoiceIntent, language: string, t: number, entry: string, suggestionId: string | null, convId: string | null) {
  const vsid = uuid();
  const qualifies = chance(P.qualifies);
  const duration = qualifies ? Math.round(between(35, 540)) : Math.round(between(5, 29));
  const turns = qualifies ? Math.round(between(2, 9)) : Math.round(between(0, 1));
  const startLatency = Math.round(between(600, 1500) + (chance(0.06) ? between(500, 1800) : 0));
  const preset = PRESET_BY_INTENT[intent].presetId;
  rows.voice_sessions.push([vsid, userId, convId, suggestionId, preset, entry, 'ended', iso(t), iso(t + duration * 1000), 'user', language, qualifies, startLatency, duration, Math.max(0, turns - 1), turns, intent, language]);
  event('voice_session_started', t, userId, arm, intent, language, { voice_session_id: vsid, preset_id: preset, entry_point: entry, opening_source: 'llm', opening_ms: Math.round(between(250, 600)), suggestion_id: suggestionId }, 'server');
  usage(t, 'opening', 'openai/gpt-oss-20b', userId, 450, 40, between(250, 600), { vsid });
  for (let i = 0; i < turns; i++) {
    const tt = t + (i + 1) * 30_000;
    usage(tt, 'stt', 'whisper-large-v3-turbo', userId, 0, 0, between(250, 900), { vsid, audio: between(4, 40) });
    usage(tt + 800, 'coach', 'openai/gpt-oss-120b', userId, 900, 110, between(700, 1600), { vsid, ttft: between(350, 1100) });
  }
  if (turns > 0) usage(t + duration * 1000, 'summary', 'openai/gpt-oss-120b', userId, 1500, 160, between(900, 2500), { vsid });
  event('voice_session_completed', t + duration * 1000, userId, arm, intent, language, {
    voice_session_id: vsid,
    preset_id: preset,
    duration_s: duration,
    questions: Math.max(0, turns - 1),
    user_turns: turns,
    end_reason: 'user',
    dominant_language: language,
    qualifies_for_wavl: qualifies,
    start_latency_ms: startLatency,
    coach_prompt: 'coach-v1',
  }, 'server');
  return t;
}

function generate() {
  for (let u = 0; u < USERS; u++) {
    const userId = uuid();
    const created = now - between(0, DAYS) * DAY;
    const tz = chance(0.9) ? 'Asia/Kolkata' : 'UTC';
    rows.users.push([userId, `syn_${u}`, `Synthetic ${u}`, 'IN', pick(['tier2', 'tier3']), 'synthetic', tz, false, iso(created)]);
    const arm = armFor(userId, cfg);
    const firstChat = created + between(0.01, 0.5) * DAY;
    const conv = uuid();
    rows.conversations.push([conv, userId, iso(firstChat), iso(firstChat)]);
    // A first ordinary chat message (activity for D30), and maybe a return around day 30–36.
    rows.messages.push([uuid(), conv, 'user', 'synthetic', null, iso(firstChat)]);
    const back = firstChat + between(30.2, 36.5) * DAY;
    if (chance(P.d30) && back < now) rows.messages.push([uuid(), conv, 'user', 'synthetic', null, iso(back)]);

    const starts: number[] = [];
    const lang = pick(['en', 'hinglish'], [0.62, 0.38]);
    let assigned = false;
    let shownAt: number | null = null;

    if (chance(P.eligibleUser)) {
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const t = firstChat + between(0, Math.max(0.1, (now - firstChat) / DAY - 0.05)) * DAY;
        if (t >= now) continue;
        if (!assigned) {
          rows.experiment_assignments.push([userId, EXP, arm, iso(t)]);
          assigned = true;
        }
        const intent = pick(VOICE_INTENTS, [0.4, 0.3, 0.2, 0.1]);
        const q = uuid();
        const a = uuid();
        rows.messages.push([q, conv, 'user', 'synthetic', null, iso(t)], [a, conv, 'assistant', 'synthetic', q, iso(t + 3000)]);
        const sid = `sg_${a}`;
        const conf = between(0.86, 0.99);
        const treat = arm === 'treatment' && scenario !== 'aa';
        const status = treat ? 'shown' : 'eligible_control';
        rows.suggestions.push([sid, a, conv, userId, intent, conf, lang, arm, status, iso(t + 3000)]);
        rows.suggestion_decisions.push([iso(t + 3000), userId, conv, a, status, arm, intent, conf, lang, 'model', Math.round(between(250, 1400)), Math.round(between(300, 1500))]);
        event('suggestion_eligible', t + 3000, userId, arm, intent, lang, { suggestion_id: sid, confidence: conf, classifier_version: 'openai/gpt-oss-20b@clf-v2', dogfood: false }, 'server');
        usage(t, 'classifier', 'openai/gpt-oss-20b', userId, 620, 45, between(250, 1400));
        usage(t, 'chat', 'openai/gpt-oss-120b', userId, 1200, 420, between(1500, 4000), { ttft: between(250, 900) });

        if (treat && chance(P.shownVisible)) {
          event('suggestion_shown', t + 4000, userId, arm, intent, lang, { suggestion_id: sid });
          shownAt ??= t + 4000;
          if (chance(P.tap)) {
            event('suggestion_tapped', t + 9000, userId, arm, intent, lang, { suggestion_id: sid });
            if (chance(P.micOk)) {
              event('mic_permission_granted', t + 12_000, userId, arm, intent, null, { suggestion_id: sid, entry_point: 'suggestion_card' });
              if (chance(P.startAfterMic)) starts.push(voiceSession(userId, arm, intent, lang, t + 14_000, 'suggestion_card', sid, conv));
            } else event('mic_permission_denied', t + 12_000, userId, arm, intent, null, { suggestion_id: sid, entry_point: 'suggestion_card', permanent: chance(0.5), reason: 'denied' });
          } else if (chance(0.3)) event('suggestion_dismissed', t + 20_000, userId, arm, intent, lang, { suggestion_id: sid, consecutive_count: 1, paused: false });
        }
        if (chance(P.feedback)) {
          const down = chance(treat ? P.thumbsDown.treatment : P.thumbsDown.control);
          event('answer_feedback', t + 30_000, userId, arm, intent, lang, { message_id: a, thumbs: down ? 'down' : 'up', had_suggestion: treat });
        }
      }
    }
    const armOrNull = assigned ? arm : null;
    // Organic voice (no card): both arms, same rate.
    if (chance(P.organicStartPerUser)) {
      const t = firstChat + between(0, Math.max(0.1, (now - firstChat) / DAY)) * DAY;
      if (t < now) starts.push(voiceSession(userId, armOrNull ?? 'none', pick(VOICE_INTENTS), lang, t, 'mic_button', null, null));
    }
    // Retention: after the first session, maybe come back on days 1–7 (and a bit later).
    if (starts.length) {
      const first = Math.min(...starts);
      const pRet = arm === 'treatment' && assigned ? P.retention.treatment : P.retention.control;
      if (chance(pRet)) {
        const t = first + between(1.05, 7.4) * DAY;
        if (t < now) voiceSession(userId, armOrNull ?? 'none', pick(VOICE_INTENTS), lang, t, 'practice_again', null, null);
      }
    }
    const optAt = shownAt === null ? Infinity : shownAt + between(0.01, 3) * DAY;
    if (shownAt !== null && chance(P.optOut) && optAt < now) event('suggestions_opted_out', optAt, userId, armOrNull, null, null, { source: pick(['card', 'settings']) });
  }
  // Events for unassigned users carry no arm; fix up the 'none' placeholders.
  for (const e of rows.events) if (e[7] === 'none') {
    e[6] = null;
    e[7] = null;
  }
}

async function bulk(db: Db, table: string) {
  const cols = COLS[table]!;
  const data = (rows as Record<string, Row[]>)[table]!;
  for (let i = 0; i < data.length; i += 500) {
    const chunk = data.slice(i, i + 500);
    const values: unknown[] = [];
    const tuples = chunk.map((r, j) => `(${cols.map((_, k) => `$${j * cols.length + k + 1}`).join(',')})`);
    for (const r of chunk) values.push(...r.map((v) => (v === undefined ? null : v)));
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, values);
  }
}

async function main() {
  const url = await analyticsDatabaseUrl(opt('database-url', '') || undefined, { create: true });
  if (/\/svs_(dev|test)(\?|$)/.test(url) && !args.includes('--force')) throw new Error(`Refusing to seed ${new URL(url).pathname}: use a separate database (or --force).`);
  const db = createDb(url)!;
  await runMigrations(db);
  generate();
  await db.tx(async (c) => {
    const syn = "SELECT id FROM users WHERE cohort = 'synthetic'";
    await c.query(`DELETE FROM events WHERE user_id IN (${syn})`);
    await c.query(`DELETE FROM llm_usage WHERE user_id IN (${syn})`);
    await c.query(`DELETE FROM suggestion_decisions WHERE user_id IN (${syn})`);
    await c.query(`DELETE FROM users WHERE cohort = 'synthetic'`); // cascades to assignments, chats, suggestions, sessions
  });
  const order = ['users', 'experiment_assignments', 'conversations', 'messages', 'suggestions', 'suggestion_decisions', 'voice_sessions', 'events', 'llm_usage'];
  for (const t of order) await bulk(db, t);
  await db.close();
  console.log(`✔ Seeded scenario "${scenario}" (seed ${SEED}) into ${describeUrl(url)}`);
  for (const t of order) console.log(`  ${t.padEnd(24)} ${(rows as Record<string, Row[]>)[t]!.length}`);
  console.log('\nNext: npm run analytics:report   (reads the same database)');
}

main().catch((err: unknown) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
