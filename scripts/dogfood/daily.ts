/**
 * P8.3 daily dogfood triage report: what the dogfood cohort did and hit in the last day.
 *
 *   npm run dogfood:daily -- [--hours 24] [--database-url …] [--out data/intent-eval/private/daily-YYYY-MM-DD.md]
 *
 * Sections: participation and consent · card funnel · decision reason codes · guardrails (opt-outs, dismissals,
 * thumbs-down) · voice session outcomes · open "Report a problem" items · firing alerts · Groq errors.
 * It contains participants' own problem reports, so it prints to the console (or a private file), never to docs/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { ConfigService } from '../../apps/server/src/config/service';
import { createDb } from '../../apps/server/src/db';

loadDotenv({ quiet: true });
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const hours = Number(flag('hours') ?? '24');
const url = flag('database-url') ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL or pass --database-url');

const db = createDb(url)!;
const L: string[] = [];
try {
  const config = new ConfigService(db, { reloadMs: 60000 });
  await config.load();
  const cohorts = config.get().dogfoodCohorts;
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const p = [since, cohorts];
  const one = async <T>(sql: string) => (await db.query<T & Record<string, unknown>>(sql, p)).rows;
  const DF = `JOIN users u ON u.id = e.user_id AND u.cohort = ANY($2)`;

  L.push(`# Dogfood daily triage: last ${hours} h (since ${since.slice(0, 16)}Z)`, '', `Cohorts: ${cohorts.join(', ') || '(none configured!)'}`, '');

  const [people] = await one<{ total: number; active: number; granted: number; declined: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.user_id = u.id AND m.role = 'user' AND m.created_at >= $1))::int AS active,
            count(*) FILTER (WHERE research_consent = 'granted')::int AS granted, count(*) FILTER (WHERE research_consent = 'declined')::int AS declined
       FROM users u WHERE u.cohort = ANY($2)`,
  );
  L.push('## Participation', `- ${people?.active ?? 0} of ${people?.total ?? 0} participants active · research consent: ${people?.granted ?? 0} granted, ${people?.declined ?? 0} declined`, '');

  const funnel = await one<{ event: string; n: number }>(`SELECT e.event, count(*)::int AS n FROM events e ${DF} WHERE e.ts >= $1 GROUP BY 1 ORDER BY 2 DESC`);
  const n = (ev: string) => funnel.find((f) => f.event === ev)?.n ?? 0;
  L.push('## Card funnel', `eligible ${n('suggestion_eligible')} → shown ${n('suggestion_shown')} → tapped ${n('suggestion_tapped')} → mic allowed ${n('mic_permission_granted')} → session started ${n('voice_session_started')} → completed ${n('voice_session_completed')}`);
  L.push(`dismissed ${n('suggestion_dismissed')} · opted out ${n('suggestions_opted_out')} · mic denied ${n('mic_permission_denied')} · network drops ${n('voice_session_network_drop')} · noisy-room hints ${n('noisy_room_hint_shown')}`, '');

  const reasons = await one<{ outcome: string; n: number }>(
    `SELECT d.outcome, count(*)::int AS n FROM suggestion_decisions d JOIN users u ON u.id = d.user_id AND u.cohort = ANY($2) WHERE d.at >= $1 GROUP BY 1 ORDER BY 2 DESC`,
  );
  L.push('## Decision reason codes', reasons.length ? reasons.map((r) => `${r.outcome} ${r.n}`).join(' · ') : '(none)', '');

  const thumbs = await one<{ thumbs: string; n: number }>(`SELECT e.props->>'thumbs' AS thumbs, count(*)::int AS n FROM events e ${DF} WHERE e.event = 'answer_feedback' AND e.ts >= $1 GROUP BY 1`);
  const down = await one<{ message_id: string; had: boolean }>(
    `SELECT e.props->>'message_id' AS message_id, (e.props->>'had_suggestion')::boolean AS had FROM events e ${DF} WHERE e.event = 'answer_feedback' AND e.props->>'thumbs' = 'down' AND e.ts >= $1 ORDER BY e.ts DESC LIMIT 20`,
  );
  L.push('## Thumbs', `up ${thumbs.find((t) => t.thumbs === 'up')?.n ?? 0} · down ${thumbs.find((t) => t.thumbs === 'down')?.n ?? 0}`);
  for (const d of down) L.push(`- 👎 message ${d.message_id}${d.had ? ' (had a card)' : ''}`);
  L.push('');

  const voice = await one<{ end_reason: string | null; n: number; p95: number | null }>(
    `SELECT vs.end_reason, count(*)::int AS n, percentile_cont(0.95) WITHIN GROUP (ORDER BY vs.start_latency_ms) AS p95
       FROM voice_sessions vs JOIN users u ON u.id = vs.user_id AND u.cohort = ANY($2) WHERE vs.started_at >= $1 GROUP BY 1 ORDER BY 2 DESC`,
  );
  L.push('## Voice sessions', voice.length ? voice.map((v) => `${v.end_reason ?? 'active'} ${v.n}`).join(' · ') : '(none)', '');

  // Every open report, not just today's: triage until each is triaged or closed.
  const reports = (
    await db.query<{ id: string; kind: string; text: string; handle: string; created_at: Date; voice_session_id: string | null }>(
      `SELECT f.id::text, f.kind, f.text, u.handle, f.created_at, f.voice_session_id FROM feedback_reports f JOIN users u ON u.id = f.user_id
        WHERE f.status = 'open' ORDER BY f.created_at DESC LIMIT 50`,
    )
  ).rows;
  L.push(`## Open problem reports (${reports.length})`);
  for (const r of reports) L.push(`- #${r.id} [${r.kind}] ${r.handle} ${new Date(r.created_at).toISOString().slice(0, 16)}${r.voice_session_id ? ` (voice ${r.voice_session_id})` : ''}: ${r.text.replace(/\s+/g, ' ')}`);
  L.push('Triage: PATCH /v1/admin/feedback/:id {"status":"triaged","triage":"BB-xx"}', '');

  const alerts = (await db.query<{ rule: string; key: string; severity: string; value: number | null }>("SELECT rule, key, severity, value FROM alert_events WHERE status = 'firing' ORDER BY fired_at")).rows;
  L.push(`## Firing alerts (${alerts.length})`, ...alerts.map((a) => `- [${a.severity}] ${a.rule}${a.key ? `:${a.key}` : ''} = ${a.value ?? 'n/a'}`), '');

  const groq = (
    await db.query<{ use_case: string; calls: number; errors: number; rl: number }>(
      `SELECT use_case, count(*)::int AS calls, count(*) FILTER (WHERE status <> 'ok')::int AS errors, count(*) FILTER (WHERE error_kind = 'rate_limited')::int AS rl
         FROM llm_usage WHERE at >= $1 GROUP BY 1 ORDER BY 1`,
      [since],
    )
  ).rows;
  L.push('## Groq (all traffic)', ...groq.map((g) => `- ${g.use_case}: ${g.calls} calls, ${g.errors} errors (${g.rl} rate-limited)`), '');
} finally {
  await db.close();
}
const md = L.join('\n');
console.log(md);
const out = flag('out');
if (out) {
  if (!out.startsWith('data/intent-eval/private/')) throw new Error('--out must be under data/intent-eval/private/ (the report contains participants\' own words)');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
}
