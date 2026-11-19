/**
 * Starts everything for a demo in one terminal, and stops it all on Ctrl+C.
 *
 *   npm run demo            API (real Groq, from .env) + web app on http://localhost:5173
 *   npm run demo:offline    the same with a built-in fake Groq: no key, no rate limits, scripted answers
 *
 * Run `npm run demo:setup` once before (it turns on suggestions and every feature in the local database).
 */
import { spawn, type ChildProcess } from 'node:child_process';

const offline = process.argv.includes('--offline');
const children: ChildProcess[] = [];

function run(name: string, color: number, cmd: string, env: Record<string, string> = {}) {
  const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream: NodeJS.ReadableStream | null) => {
    let buf = '';
    stream?.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) process.stdout.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited (${code ?? 'signal'})\n`);
    if (!stopping) stopAll(1);
  });
  children.push(child);
}

let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.pid === undefined || c.exitCode !== null) continue;
    // Windows: kill the whole process tree (npm → node), or the servers keep running in the background.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 800);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

if (offline) {
  run('fake-groq', 35, 'npx tsx scripts/fake-groq.ts 8790');
  run('server', 34, 'npm run dev -w @svs/server', { GROQ_BASE_URL: 'http://127.0.0.1:8790', GROQ_API_KEY: 'gsk_offline_demo' });
} else run('server', 34, 'npm run dev -w @svs/server');
run('web', 32, 'npm run dev -w @svs/web');
console.log(`Starting the demo (${offline ? 'offline: fake Groq' : 'real Groq'})… open http://localhost:5173 in Chrome. Ctrl+C stops everything.`);
