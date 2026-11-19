import { useEffect, useMemo, useState } from 'react';
import { FUNNEL_STEPS, type ArmComparison, type ArmOrNone, type FunnelStep, type MetricsReport, type Proportion } from '@svs/shared';
import { api, ApiError } from '../lib/api';

/**
 * P6.3 Analytics dashboard (admins only): PRD decision, headline metrics, the card funnel sliced by arm / intent /
 * language, experiment health (SRM), Groq health and alerts. Data: GET /v1/admin/analytics/report.
 * Charts are plain HTML: one hue for the funnel (single series, no legend), status shown with icon + label.
 */
type Decision = { decision: string; reasons: string[]; checks: Array<{ name: string; pass: boolean | null; detail: string }> };

const STEP_LABEL: Record<FunnelStep, string> = {
  eligible: 'Eligible',
  shown: 'Card shown',
  tapped: 'Tapped',
  permission_ok: 'Mic allowed',
  started: 'Session started',
  completed_30s: 'Completed ≥30 s',
  returned_d7: 'Returned within 7 days',
};
const DECISION_LABEL: Record<string, string> = { ship: 'Ship', iterate: 'Iterate', kill: 'Kill', inconclusive: 'Inconclusive', invalid: 'Invalid (fix the experiment first)' };

const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`);
const pp = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pp`);
const pval = (v: number | null) => (v === null ? '—' : v < 0.001 ? 'p < 0.001' : `p = ${v.toFixed(3)}`);
const ms = (v: number | null) => (v === null ? '—' : `${Math.round(v)} ms`);
const usd = (v: number | null) => (v === null ? '—' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

export function AnalyticsDashboard({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState(28);
  const [experiment, setExperiment] = useState<'configured' | 'all'>('configured');
  const [arm, setArm] = useState<ArmOrNone>('treatment');
  const [intent, setIntent] = useState('all');
  const [language, setLanguage] = useState('all');
  const [data, setData] = useState<{ report: MetricsReport; decision: Decision | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    api
      .analyticsReport({ from: from.toISOString(), to: to.toISOString(), ...(experiment === 'all' ? { experiment_id: 'all' } : {}) })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        if (experiment === 'all') setArm('none');
        else setArm((a) => (a === 'none' ? 'treatment' : a));
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof ApiError && e.status === 403 ? 'Analytics is for admins only.' : "Couldn't load analytics."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days, experiment]);

  const r = data?.report;
  const intents = useMemo(() => [...new Set((r?.funnel ?? []).map((f) => f.intent ?? 'unknown'))].sort(), [r]);
  const languages = useMemo(() => [...new Set((r?.funnel ?? []).map((f) => f.language ?? 'unknown'))].sort(), [r]);
  const steps = useMemo(() => {
    const total = Object.fromEntries(FUNNEL_STEPS.map((s) => [s, 0])) as Record<FunnelStep, number>;
    for (const row of r?.funnel ?? []) {
      if (row.arm !== arm) continue;
      if (intent !== 'all' && (row.intent ?? 'unknown') !== intent) continue;
      if (language !== 'all' && (row.language ?? 'unknown') !== language) continue;
      for (const s of FUNNEL_STEPS) total[s] += row.steps[s];
    }
    return total;
  }, [r, arm, intent, language]);

  return (
    <div className="dash">
      <header className="topbar">
        <button type="button" className="btn btn-small" onClick={onClose}>
          ← Chat
        </button>
        <h1 className="brand">Voice Suggestions analytics</h1>
        <span className="muted small">{r ? r.version : ''}</span>
      </header>

      <main className="dash-body">
        <div className="dash-filters" role="group" aria-label="Filters">
          <label>
            Window{' '}
            <select className="input select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={28}>Last 28 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
          <label>
            Scope{' '}
            <select className="input select" value={experiment} onChange={(e) => setExperiment(e.target.value as 'configured' | 'all')}>
              <option value="configured">Experiment {r?.window.experiment_id ?? ''}</option>
              <option value="all">All traffic (incl. dogfood)</option>
            </select>
          </label>
          <label>
            Arm{' '}
            <select className="input select" value={arm} onChange={(e) => setArm(e.target.value as ArmOrNone)} disabled={experiment === 'all'}>
              <option value="treatment">Treatment</option>
              <option value="control">Control</option>
              <option value="none">Not in experiment</option>
            </select>
          </label>
          <label>
            Intent{' '}
            <select className="input select" value={intent} onChange={(e) => setIntent(e.target.value)}>
              <option value="all">All</option>
              {intents.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </label>
          <label>
            Language{' '}
            <select className="input select" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="all">All</option>
              {languages.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {loading && !r && <p className="muted">Loading…</p>}

        {r && (
          <>
            {data?.decision && <DecisionPanel d={data.decision} />}

            <section className="dash-tiles" aria-label="Headline metrics">
              <Tile label="WAVL (learner-weeks)" value={String(r.metrics.wavl.reduce((s, w) => s + w.learners, 0))} note={`${r.metrics.wavl.length ? r.metrics.wavl[r.metrics.wavl.length - 1]!.week : 'no weeks'} latest`} />
              <Tile label="Card start rate" value={pct(r.metrics.card_start_rate.rate)} note={`${r.metrics.card_start_rate.num}/${r.metrics.card_start_rate.den} cards · target ≥15%`} />
              <CompareTile label="Eligible-user start rate" c={r.metrics.eligible_start_rate} />
              <CompareTile label="D7 voice retention" c={r.metrics.d7_voice_retention} />
              <Tile
                label="Opt-out rate"
                value={pct(r.metrics.opt_out_rate.rate)}
                note={`${r.metrics.opt_out_rate.num}/${r.metrics.opt_out_rate.den} users · guardrail ≤5%`}
                status={r.metrics.opt_out_rate.rate === null ? null : r.metrics.opt_out_rate.rate > 0.05 ? 'critical' : 'good'}
              />
              <Tile
                label="SVS cost per WAVL"
                value={usd(r.metrics.cost.per_wavl_usd)}
                note={`${usd(r.metrics.cost.svs_usd)} SVS · ${usd(r.metrics.cost.chat_usd)} chat · budget ${r.metrics.cost.budget_per_wavl_usd === null ? 'not set' : usd(r.metrics.cost.budget_per_wavl_usd)}`}
              />
            </section>

            <section className="dash-card" aria-labelledby="funnel-title">
              <div className="dash-card-head">
                <h2 id="funnel-title">Card funnel · {arm === 'none' ? 'not in experiment' : arm}</h2>
                <button type="button" className="btn btn-small" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>
                  {showTable ? 'Show chart' : 'Show table'}
                </button>
              </div>
              {arm === 'control' && <p className="muted small">Control never sees a card: only the shadow “eligible” step is counted.</p>}
              {showTable ? <FunnelTable steps={steps} /> : <FunnelChart steps={steps} />}
            </section>

            <section className="dash-card" aria-labelledby="metrics-title">
              <h2 id="metrics-title">Metrics by arm</h2>
              <div className="table-wrap">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      <th scope="col">Control</th>
                      <th scope="col">Treatment</th>
                      <th scope="col">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    <CompareRow name="Eligible-user start rate (primary)" c={r.metrics.eligible_start_rate} />
                    <CompareRow name="D7 voice retention (primary)" c={r.metrics.d7_voice_retention} />
                    <CompareRow name="D30 retention (proxy)" c={r.metrics.d30_retention} />
                    <tr>
                      <th scope="row">Sessions per user per week</th>
                      <td>{fmtNum(r.metrics.sessions_per_user_week.control.value)}</td>
                      <td>{fmtNum(r.metrics.sessions_per_user_week.treatment.value)}</td>
                      <td>—</td>
                    </tr>
                    <tr>
                      <th scope="row">Thumbs-down (control-eligible vs with card)</th>
                      <td>{fmtProp(r.metrics.thumbs_down.control_eligible)}</td>
                      <td>{fmtProp(r.metrics.thumbs_down.with_card)}</td>
                      <td>
                        {pp(r.metrics.thumbs_down.diff)} <span className="muted small">{pval(r.metrics.thumbs_down.p_value)}</span>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">WAVL learner-weeks</th>
                      <td>{r.metrics.wavl.filter((w) => w.arm === 'control').reduce((s, w) => s + w.learners, 0)}</td>
                      <td>{r.metrics.wavl.filter((w) => w.arm === 'treatment').reduce((s, w) => s + w.learners, 0)}</td>
                      <td>—</td>
                    </tr>
                    <tr>
                      <th scope="row">Card tap rate</th>
                      <td>n/a</td>
                      <td>{fmtProp(r.metrics.tap_rate)}</td>
                      <td>—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {r.experiment && (
              <section className="dash-card" aria-labelledby="exp-title">
                <h2 id="exp-title">Experiment health (sample ratio)</h2>
                <p className="muted small">Expected treatment share {pct(r.experiment.expected_treatment_share, 0)}. A mismatch (p &lt; alarm level) means the split is broken.</p>
                <div className="table-wrap">
                  <table className="dash-table">
                    <thead>
                      <tr>
                        <th scope="col">Count</th>
                        <th scope="col">Control</th>
                        <th scope="col">Treatment</th>
                        <th scope="col">p-value</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          ['Assignments (all time)', r.experiment.assignments],
                          ['Eligible users', r.experiment.eligible_users],
                          ['Eligible events', r.experiment.eligible_events],
                        ] as const
                      ).map(([name, s]) => (
                        <tr key={name}>
                          <th scope="row">{name}</th>
                          <td>{s.control}</td>
                          <td>{s.treatment}</td>
                          <td>{s.p_value === null ? '—' : s.p_value.toFixed(4)}</td>
                          <td>
                            <Status level={s.p_value === null ? null : s.mismatch ? 'critical' : 'good'} label={s.p_value === null ? 'No data' : s.mismatch ? 'Mismatch' : 'OK'} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="dash-card" aria-labelledby="health-title">
              <h2 id="health-title">Groq health</h2>
              <p className="muted small">
                Voice start p50 {ms(r.health.voice_start.p50_ms)} · p95 {ms(r.health.voice_start.p95_ms)} (n = {r.health.voice_start.n}, target &lt; 2 s) · classifier errors {pct(r.health.classifier.error_rate)} of{' '}
                {r.health.classifier.calls}
              </p>
              <div className="table-wrap">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th scope="col">Use case</th>
                      <th scope="col">Calls</th>
                      <th scope="col">Errors</th>
                      <th scope="col">429</th>
                      <th scope="col">5xx</th>
                      <th scope="col">Fallback</th>
                      <th scope="col">p95</th>
                      <th scope="col">TTFT p95</th>
                      <th scope="col">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.health.use_cases.length === 0 && (
                      <tr>
                        <td colSpan={9} className="muted">
                          No Groq calls in this window.
                        </td>
                      </tr>
                    )}
                    {r.health.use_cases.map((u) => (
                      <tr key={u.use_case}>
                        <th scope="row">{u.use_case}</th>
                        <td>{u.calls}</td>
                        <td>{pct(u.error_rate)}</td>
                        <td>{pct(u.rate_limited_rate)}</td>
                        <td>{pct(u.server_error_rate)}</td>
                        <td>{pct(u.fallback_rate)}</td>
                        <td>{ms(u.p95_ms)}</td>
                        <td>{ms(u.ttft_p95_ms)}</td>
                        <td>{u.tokens.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {r.health.headroom.length > 0 && (
                <ul className="dash-list">
                  {r.health.headroom.map((h) => (
                    <li key={h.model}>
                      <strong>{h.model}</strong>: {h.tpm_limit !== null && <>peak {h.peak_tokens_per_minute.toLocaleString()} of {h.tpm_limit.toLocaleString()} tokens/min · </>}
                      {h.requests_today} of {h.rpd_limit} requests today
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="dash-card" aria-labelledby="alerts-title">
              <h2 id="alerts-title">Alerts</h2>
              {r.alerts.length === 0 ? (
                <p className="muted">No alerts in this window.</p>
              ) : (
                <ul className="dash-list">
                  {r.alerts.map((a) => (
                    <li key={a.id}>
                      <Status level={a.status === 'resolved' ? 'good' : a.severity} label={a.status === 'resolved' ? 'Resolved' : a.severity === 'critical' ? 'Critical' : 'Warning'} />{' '}
                      <strong>
                        {a.rule}
                        {a.key ? `:${a.key}` : ''}
                      </strong>{' '}
                      = {fmtNum(a.value)} (threshold {fmtNum(a.threshold)}) · <span className="muted small">{new Date(a.fired_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function DecisionPanel({ d }: { d: Decision }) {
  return (
    <section className="dash-card dash-decision" aria-labelledby="decision-title">
      <h2 id="decision-title">
        PRD decision: <span className={`decision decision-${d.decision}`}>{DECISION_LABEL[d.decision] ?? d.decision}</span>
      </h2>
      {d.reasons.map((x) => (
        <p key={x}>{x}</p>
      ))}
      <ul className="dash-list">
        {d.checks.map((c) => (
          <li key={c.name}>
            <Status level={c.pass === null ? null : c.pass ? 'good' : 'critical'} label={c.pass === null ? 'No data' : c.pass ? 'Pass' : 'Fail'} /> <strong>{c.name}</strong>
            <span className="muted small"> · {c.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Status({ level, label }: { level: 'good' | 'warning' | 'critical' | null; label: string }) {
  const icon = level === 'good' ? '✓' : level === 'warning' ? '!' : level === 'critical' ? '✕' : '–';
  return (
    <span className={`status status-${level ?? 'none'}`}>
      <span className="status-icon" aria-hidden="true">
        {icon}
      </span>
      {label}
    </span>
  );
}

function Tile({ label, value, note, status }: { label: string; value: string; note?: string; status?: 'good' | 'critical' | null }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {note && <span className="tile-note">{note}</span>}
      {status !== undefined && status !== null && <Status level={status} label={status === 'good' ? 'Within guardrail' : 'Above guardrail'} />}
    </div>
  );
}

function CompareTile({ label, c }: { label: string; c: ArmComparison }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{pp(c.diff)}</span>
      <span className="tile-note">
        T {pct(c.treatment.rate)} vs C {pct(c.control.rate)} · {pval(c.p_value)}
      </span>
    </div>
  );
}

function CompareRow({ name, c }: { name: string; c: ArmComparison }) {
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{fmtProp(c.control)}</td>
      <td>{fmtProp(c.treatment)}</td>
      <td>
        {pp(c.diff)} <span className="muted small">{pval(c.p_value)}</span>
      </td>
    </tr>
  );
}

const fmtProp = (p: Proportion) => `${pct(p.rate)} (${p.num}/${p.den})`;
const fmtNum = (v: number | null) => (v === null ? '—' : Math.abs(v) < 1 && v !== 0 ? v.toFixed(3) : String(Math.round(v * 100) / 100));

/** Horizontal bars in the funnel's natural order, one hue, value + conversion as direct labels, hover/focus tooltip. */
function FunnelChart({ steps }: { steps: Record<FunnelStep, number> }) {
  const [hover, setHover] = useState<FunnelStep | null>(null);
  const max = Math.max(1, steps.eligible, ...FUNNEL_STEPS.map((s) => steps[s]));
  if (steps.eligible === 0 && steps.shown === 0) return <p className="muted">No eligible suggestions for this slice.</p>;
  return (
    <ol className="funnel" aria-label="Funnel, eligible to returned within 7 days">
      {FUNNEL_STEPS.map((s, i) => {
        const prev = i > 0 ? steps[FUNNEL_STEPS[i - 1]!] : null;
        const ofPrev = prev ? steps[s] / prev : null;
        const ofFirst = steps.eligible ? steps[s] / steps.eligible : null;
        return (
          <li
            key={s}
            className="funnel-row"
            tabIndex={0}
            onMouseEnter={() => setHover(s)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(s)}
            onBlur={() => setHover(null)}
            aria-label={`${STEP_LABEL[s]}: ${steps[s]}${ofPrev !== null ? `, ${pct(ofPrev)} of previous step` : ''}`}
          >
            <span className="funnel-label">{STEP_LABEL[s]}</span>
            <span className="funnel-track">
              <span className="funnel-bar" style={{ width: `calc((100% - 8.5rem) * ${steps[s] / max})` }} />
              <span className="funnel-value">
                {steps[s].toLocaleString()}
                {ofPrev !== null && <span className="muted"> · {pct(ofPrev)}</span>}
              </span>
              {hover === s && (
                <span className="viz-tooltip" role="tooltip">
                  <strong>{STEP_LABEL[s]}</strong>
                  <span>{steps[s].toLocaleString()} suggestions</span>
                  <span>{pct(ofFirst)} of eligible</span>
                  {ofPrev !== null && <span>{pct(ofPrev)} of previous step</span>}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function FunnelTable({ steps }: { steps: Record<FunnelStep, number> }) {
  return (
    <div className="table-wrap">
      <table className="dash-table">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Suggestions</th>
            <th scope="col">% of eligible</th>
            <th scope="col">% of previous</th>
          </tr>
        </thead>
        <tbody>
          {FUNNEL_STEPS.map((s, i) => {
            const prev = i > 0 ? steps[FUNNEL_STEPS[i - 1]!] : null;
            return (
              <tr key={s}>
                <th scope="row">{STEP_LABEL[s]}</th>
                <td>{steps[s]}</td>
                <td>{pct(steps.eligible ? steps[s] / steps.eligible : null)}</td>
                <td>{pct(prev ? steps[s] / prev : null)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
