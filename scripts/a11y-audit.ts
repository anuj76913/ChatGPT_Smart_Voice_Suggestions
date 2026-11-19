/**
 * P7.2 automated accessibility walkthrough in a real browser (headless Chrome via the DevTools protocol).
 * Drives the actual UI end to end, offline (fake Groq, fake microphone), and on every screen runs:
 *   - axe-core, WCAG 2.0/2.1/2.2 A + AA rules plus best practices
 *   - a touch-target check: every visible control must be ≥ 44 × 44 px (plan: 48 dp / 44 pt)
 *   - a screenshot (for a human look)
 * Screens: chat (signed in automatically), chat with card, settings, privacy notice, voice session, end confirmation, summary,
 * chat with recap, mic-denied, dark mode, desktop, analytics dashboard.
 *
 * Needs the stack running against fake Groq:
 *   npx tsx scripts/fake-groq.ts 8790
 *   GROQ_BASE_URL=http://127.0.0.1:8790 GROQ_API_KEY=x PORT=8789 ADMIN_USERS=a11y_admin npm run dev:server
 *   VITE_API_TARGET=http://127.0.0.1:8789 npx vite --port 5175   (in apps/web)
 *   npm run audit:a11y -- [--base http://localhost:5175] [--out docs/phase7/a11y-report.md] [--shots <dir>]
 *
 * Not a substitute for TalkBack / VoiceOver walkthroughs by a person (P7.2); it catches the machine-checkable part.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const BASE = opt('base', 'http://localhost:5175');
const OUT = opt('out', '');
// --admin <handle>: a handle listed in the server's ADMIN_USERS (for the dashboard screen).

const SHOTS = opt('shots', join(tmpdir(), 'svs-a11y-shots'));
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
mkdirSync(SHOTS, { recursive: true });

// ---------- CDP plumbing ----------
const profile = join(tmpdir(), `svs-a11y-chrome-${Date.now()}`);
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${profile}`, '--no-first-run', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
let wsUrl = '';
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const t = (await (await fetch('http://127.0.0.1:9334/json')).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    wsUrl = t.find((x) => x.type === 'page')?.webSocketDebuggerUrl ?? '';
  } catch {
    /* not up yet */
  }
  if (!wsUrl) await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.on('open', r));
let seq = 0;
const pending = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
const browserErrors: string[] = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw)) as { id?: number; method?: string; params?: { exceptionDetails?: { exception?: { description?: string }; text?: string }; type?: string; args?: Array<{ value?: unknown; description?: string }> } };
  // Browser-side crashes and console errors are findings too.
  if (m.method === 'Runtime.exceptionThrown') browserErrors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? 'exception');
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') browserErrors.push((m.params.args ?? []).map((x) => String(x.value ?? x.description ?? '')).join(' ').slice(0, 3000));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m as never);
    pending.delete(m.id);
  }
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result ?? {})));
    ws.send(JSON.stringify({ id, method, params }));
  });
async function js<T = unknown>(expression: string): Promise<T> {
  const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  return r.result.value;
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(expr: string, label: string, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await js<boolean>(`!!(${expr})`).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const clickText = (text: string, selector = 'button, a') =>
  js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim().includes(${JSON.stringify(text)}) && e.offsetParent !== null); if (!el) throw new Error('no element with text ${text.replace(/'/g, '')}'); el.click(); return true; })()`);
const click = (selector: string) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector}'); el.click(); return true; })()`);
/** Sets a React-controlled input's value and fires input events. */
const typeInto = (selector: string, value: string) =>
  js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

async function viewport(width: number, height: number, mobile: boolean, scheme: 'light' | 'dark' = 'light') {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
}

// ---------- checks ----------
interface Violation {
  id: string;
  impact: string;
  help: string;
  nodes: number;
  targets: string[];
}
interface ScreenResult {
  screen: string;
  violations: Violation[];
  smallTargets: Array<{ el: string; w: number; h: number }>;
}
const results: ScreenResult[] = [];

async function audit(screen: string) {
  await sleep(400);
  const hasAxe = await js<boolean>('typeof window.axe !== "undefined"');
  if (!hasAxe) await js(AXE + ';true');
  const v = await js<Violation[]>(`axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice'] }, resultTypes: ['violations'] })
    .then(r => r.violations.map(x => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.length, targets: x.nodes.slice(0, 3).map(n => n.target.join(' ')) })))`);
  // Touch targets: interactive elements actually visible; inline links inside running text are exempt (WCAG 2.5.8).
  const small = await js<ScreenResult['smallTargets']>(`[...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [tabindex]:not([tabindex="-1"])')]
    .filter(e => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden')
    .filter(e => !(e.tagName === 'A' && e.closest('p, li') && !e.classList.contains('btn')))
    .map(e => { const r = e.getBoundingClientRect(); return { el: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 40) + ' <' + e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : '') + '>', w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(x => x.w > 0 && (x.w < 44 || x.h < 44))`);
  results.push({ screen, violations: v, smallTargets: small });
  const shot = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string };
  writeFileSync(join(SHOTS, `${String(results.length).padStart(2, '0')}-${screen.replace(/[^a-z0-9]+/gi, '-')}.png`), Buffer.from(shot.data, 'base64'));
  console.log(`${v.length || small.length ? '⚠' : '✔'} ${screen}: ${v.length} axe violation(s), ${small.length} small target(s)`);
  for (const x of v) console.log(`    [${x.impact}] ${x.id}: ${x.help} (${x.nodes}) ${x.targets.join(' | ')}`);
  for (const s of small) console.log(`    target ${s.w}×${s.h}: ${s.el}`);
}

async function go(path: string) {
  await send('Page.navigate', { url: BASE + path });
  await sleep(1200);
}

// ---------- walkthrough ----------
let stopped = '';
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.clearBrowserCookies');
  await viewport(390, 844, true);
  // No sign-in screen: the app signs this browser in as an anonymous learner on first load.
  await go('/');
  await waitFor('document.querySelector("textarea")', 'chat composer', 20000);
  await audit('Chat, empty (mobile)');

  // Phase 8: the mic button's practice picker (voice without a card).
  await click('[aria-label="Practise speaking"]');
  await waitFor('document.querySelector("#picker-title")', 'practice picker');
  await audit('Practice picker (mobile)');
  await clickText('Cancel');
  await sleep(300);

  // Phase 8: dogfood participants see the research-consent banner (local users are a dogfood cohort in dev).
  if (await js<boolean>('!!document.querySelector(".consent-banner")')) {
    await audit('Research-consent banner (mobile)');
    await clickText("Yes, that's OK");
    await waitFor('!document.querySelector(".consent-banner")', 'banner closed');
  }

  await typeInto('textarea', 'Take my mock interview for a TCS fresher role');
  await sleep(200);
  await js(`document.querySelector('textarea').form ? document.querySelector('textarea').form.requestSubmit() : null`);
  await waitFor('document.querySelector(".suggestion-card")', 'suggestion card', 20000);
  await audit('Chat with suggestion card (mobile)');

  await click('[aria-label="Open conversations"]');
  await sleep(300);
  await clickText('Settings');
  await waitFor('document.querySelector("[role=dialog]")', 'settings dialog');
  await audit('Settings (mobile)');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  if (await js<boolean>('!!document.querySelector("[role=dialog]")')) await clickText('Close');
  await sleep(300);
  if (await js<boolean>('!!document.querySelector(".scrim")')) await click('.scrim');

  // Phase 8: "Report a problem" (dogfood participants and admins).
  await click('[aria-label="Open conversations"]');
  await sleep(300);
  if (await js<boolean>('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Report a problem")')) {
    await clickText('Report a problem');
    await waitFor('document.querySelector("#report-title")', 'report dialog');
    await typeInto('.report-form textarea', 'The coach repeated the same question twice.');
    await sleep(200);
    await audit('Report a problem (mobile)');
    await click('.report-form button[type=submit]'); // not clickText: the composer also has a Send button
    await waitFor('!document.querySelector("#report-title")', 'report sent');
  }
  if (await js<boolean>('!!document.querySelector(".scrim")')) await click('.scrim');
  await sleep(300);

  await click('.card-cta');
  await waitFor('[...document.querySelectorAll("h2")].some(h => /Before you start/.test(h.textContent))', 'privacy notice');
  await audit('Privacy notice (mobile)');
  await clickText('Continue');
  await waitFor('document.querySelector(".voice")', 'voice session', 20000);
  await sleep(2500);
  await audit('Voice session (mobile)');
  // The microphone must actually record: listening starts and stays up, with no "microphone stopped working"
  // pause. (A dead mic stream, killed by React StrictMode's remount, once paused every session.) Chrome's fake
  // mic only beeps, so a recognised learner turn is a bonus here, not a requirement.
  const micBroken = 'document.body.textContent.includes("microphone stopped working")';
  await waitFor(`document.body.textContent.includes("Listening") || ${micBroken}`, 'listening', 30000);
  await sleep(3000);
  if (await js<boolean>(micBroken)) throw new Error('the microphone stopped working in the voice session');
  await waitFor('document.querySelector(".caption-user")', 'a learner turn', 8000).catch(() => console.log('  (fake mic beep not recognised as speech; recording itself works)'));
  await clickText('End');
  await sleep(300);
  if (await js<boolean>('!!document.querySelector(".voice-confirm")')) {
    await audit('End confirmation (mobile)');
    await clickText('End now');
  }
  await waitFor('document.querySelector(".summary")', 'summary', 20000);
  await waitFor('!document.querySelector(".summary[aria-busy=true]")', 'summary tip', 20000);
  await audit('Session summary (mobile)');
  await clickText('Back to chat');
  await waitFor('!document.querySelector(".voice")', 'back in chat', 15000);
  await sleep(1000);
  await audit('Chat after Back to Chat, with recap (mobile)');

  // Mic denied: a new chat, a new card, the browser refuses the microphone.
  await click('[aria-label="New chat"]');
  await sleep(500);
  await typeInto('textarea', 'Ask me viva questions on operating systems');
  await sleep(200);
  await js(`document.querySelector('textarea').form.requestSubmit()`);
  const gotCard = await waitFor('document.querySelector(".suggestion-card")', 'second card', 20000).then(() => true).catch(() => false);
  if (gotCard) {
    // The fake-media flag auto-accepts permission prompts, so simulate the learner tapping "Block".
    await js(`navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); true`);
    await click('.card-cta');
    await waitFor('[...document.querySelectorAll("h2")].some(h => /Microphone|mic/i.test(h.textContent))', 'mic denied dialog', 15000);
    await audit('Mic denied (mobile)');
    await clickText('Back to text');
  } else console.log('  (no second card: caps reached; mic-denied screen skipped)');

  await viewport(390, 844, true, 'dark');
  await go('/');
  await waitFor('document.querySelector("textarea")', 'chat (dark)');
  await audit('Chat, dark mode (mobile)');

  await viewport(1280, 900, false);
  await go('/');
  await waitFor('document.querySelector("textarea")', 'chat (desktop)');
  await audit('Chat (desktop)');

  // Analytics dashboard as an admin.
  const login = await fetch(`${BASE}/v1/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: opt('admin', 'a11y_admin') }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith('svs_session='))!;
  await send('Network.setCookie', { name: 'svs_session', value: cookie.slice('svs_session='.length), url: BASE });
  await go('/?as=admin#/admin/analytics'); // a different URL, so the page reloads with the admin cookie
  await waitFor('document.querySelector(".dash-tiles") || document.querySelector(".dash .error")', 'dashboard', 20000);
  await audit('Analytics dashboard (desktop)');

  // Phase 11 (--v2): voice preview and quiet mode. Needs the v2 flags on (npm run demo:setup).
  if (args.includes('--v2')) {
    const r = await fetch(`${BASE}/v1/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: `a11y_v2_${Date.now() % 1_000_000}` }) });
    const ck = r.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith('svs_session='))!;
    await send('Network.setCookie', { name: 'svs_session', value: ck.slice('svs_session='.length), url: BASE });
    await viewport(390, 844, true);
    await go('/?as=v2');
    await waitFor('document.querySelector("textarea")', 'chat (v2)');
    if (await js<boolean>('!!document.querySelector(".consent-banner")')) await clickText('No thanks');
    // Voice preview from a card.
    await typeInto('textarea', 'Take my mock interview for a TCS fresher role');
    await sleep(200);
    await js(`document.querySelector('textarea').form.requestSubmit()`);
    await waitFor('document.querySelector(".card-preview")', 'preview button on the card', 20000);
    await audit('Card with preview button (mobile)');
    await click('.card-preview');
    await waitFor('document.querySelector("#preview-title") && document.querySelectorAll(".preview-line").length >= 2', 'preview playing', 20000);
    await audit('Voice preview (mobile)');
    await clickText('Stop preview');
    await sleep(300);
    // Quiet mode, in a session started from the mic button.
    await click('[aria-label="Practise speaking"]');
    await waitFor('document.querySelector("#picker-title")', 'practice picker');
    await clickText('Spoken English Practice');
    await waitFor('[...document.querySelectorAll("h2")].some(h => /Before you start/.test(h.textContent)) || document.querySelector(".voice")', 'voice flow', 20000);
    if (await js<boolean>('[...document.querySelectorAll("h2")].some(h => /Before you start/.test(h.textContent))')) await clickText('Continue');
    await waitFor('document.querySelector(".voice")', 'voice session', 20000);
    await sleep(1500);
    await clickText('Speed / Voice');
    await waitFor('document.querySelector(".quiet-toggle [role=switch]")', 'quiet toggle');
    await click('.quiet-toggle [role=switch]');
    await sleep(300);
    await audit('Voice session with quiet mode (mobile)');
    await clickText('End');
    await sleep(300);
    if (await js<boolean>('!!document.querySelector(".voice-confirm")')) await clickText('End now');
    await waitFor('document.querySelector(".summary") && !document.querySelector(".summary[aria-busy=true]")', 'summary', 20000);
    await audit('Summary after quiet mode (mobile)');
    await clickText('Back to chat');
    await sleep(800);
  }

  // Phase 10 (--regional): one card per language, on a phone, to check fonts, wrapping and truncation.
  // Needs the server's config to allow these languages (npm run ops:language -- enable <lang> --prototype).
  if (args.includes('--regional')) {
    const r = await fetch(`${BASE}/v1/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: `a11y_rg_${Date.now() % 1_000_000}` }) });
    const ck = r.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith('svs_session='))!;
    await send('Network.setCookie', { name: 'svs_session', value: ck.slice('svs_session='.length), url: BASE });
    await viewport(360, 780, true); // a small Android phone
    await go('/?as=regional');
    await waitFor('document.querySelector("textarea")', 'chat (regional)');
    if (await js<boolean>('!!document.querySelector(".consent-banner")')) await clickText('No thanks');
    const QUERIES: Array<[string, string]> = [
      ['Hindi', 'कल मेरा TCS का इंटरव्यू है, मेरा मॉक इंटरव्यू लीजिए'],
      ['Bengali', 'কাল আমার TCS-এর ইন্টারভিউ, আমার একটা মক ইন্টারভিউ নিন'],
      ['Marathi', 'उद्या माझी TCS ची मुलाखत आहे, माझी मॉक मुलाखत घ्या'],
      ['Telugu', 'రేపు నాకు TCS ఇంటర్వ్యూ ఉంది, నాకు మాక్ ఇంటర్వ్యూ తీసుకోండి'],
    ];
    for (const [name, q] of QUERIES) {
      await click('[aria-label="New chat"]');
      await sleep(400);
      await typeInto('textarea', q);
      await sleep(200);
      await js(`document.querySelector('textarea').form.requestSubmit()`);
      await waitFor('document.querySelector(".suggestion-card")', `${name} card`, 20000);
      await js(`document.querySelector('.suggestion-card').scrollIntoView({ block: 'center' })`);
      await audit(`${name} card (360 px phone)`);
    }
  }
} catch (err) {
  stopped = (err as Error).message;
  console.error(`✖ walkthrough stopped: ${stopped}`);
  const shot = (await send('Page.captureScreenshot', { format: 'png' }).catch(() => null)) as { data: string } | null;
  if (shot) writeFileSync(join(SHOTS, 'zz-failure.png'), Buffer.from(shot.data, 'base64'));
  process.exitCode = 1;
} finally {
  ws.close();
  chrome.kill();
}

// ---------- report ----------
const uniqueErrors = [...new Set(browserErrors)].map((e) => e.split('\n').slice(0, 4).join(' | '));
if (uniqueErrors.length) console.log(`\nBrowser errors (${uniqueErrors.length}):\n${uniqueErrors.map((e) => `  - ${e}`).join('\n')}`);
const total = browserErrors.length + results.reduce((s, r) => s + r.violations.length + r.smallTargets.length, 0);
const md = [
  '| Screen | axe violations (WCAG 2.2 AA + best practice) | Targets < 44 px |',
  '|---|---|---|',
  ...results.map((r) => `| ${r.screen} | ${r.violations.length ? r.violations.map((v) => `${v.id} (${v.impact}, ${v.nodes})`).join('<br>') : '✅ none'} | ${r.smallTargets.length ? r.smallTargets.map((s) => `${s.el.replace(/[<>|]/g, ' ')} ${s.w}×${s.h}`).join('<br>') : '✅ none'} |`),
].join('\n');
const verdict = stopped
  ? `✖ Walkthrough stopped early (${stopped}); ${total} finding(s) on the ${results.length} screens reached`
  : total
    ? `⚠ ${total} finding(s) on ${results.length} screens`
    : `✔ No findings on ${results.length} screens`;
console.log(`\n${md}\n\n${verdict} · screenshots in ${SHOTS}`);
const errorList = uniqueErrors.length ? `\n\nBrowser errors:\n${uniqueErrors.map((e) => `- ${e}`).join('\n')}` : '';
if (OUT) writeFileSync(OUT, `${md}\n\n${verdict}${errorList}\n`);
