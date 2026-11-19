/**
 * Team demo setup: one command to put the local app in "show everything" mode.
 *
 *   npm run demo:setup            apply the demo config to DATABASE_URL (migrations first)
 *   npm run demo:setup -- --off   back to the normal defaults (all overrides cleared)
 *
 * Demo config (runtime overrides, audited like any other change):
 *   - suggestions on for everyone (rollout 100%, everyone sees cards: experiment svs_demo with treatment share 1)
 *   - cards in every language the eval covers: English, Hinglish, Hindi, Bengali, Marathi, Telugu (prototype)
 *   - relaxed caps so a presenter can repeat flows (20 cards a week, the maximum; 1 per conversation still)
 *   - the Phase 11 v2 bets in scope: voice preview and quiet mode
 * See docs/DEMO.md for the click-through script.
 */
import { config as loadDotenv } from 'dotenv';
import type { DeepPartial, SvsConfig } from '@svs/shared';
import { ConfigService } from '../apps/server/src/config/service';
import { createDb } from '../apps/server/src/db';
import { runMigrations } from '../apps/server/src/migrate';

loadDotenv({ quiet: true });
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('✖ DATABASE_URL is not set. Run npm run db:local:init first (see README).');
  process.exit(1);
}

const DEMO: DeepPartial<SvsConfig> = {
  enabled: true,
  rolloutPercent: 100,
  killSwitch: [],
  dogfoodCohorts: [],
  experiment: { id: 'svs_demo', treatmentShare: 1 },
  cap: { perConversation: 1, perRollingWeek: 20, rollingWindowHours: 168 }, // 20 = the validated maximum
  pause: { consecutiveDismissals: 20, days: 1 },
  classifier: { languages: ['en', 'hinglish', 'hi', 'bn', 'mr', 'te'] },
  v2: {
    previewMode: { enabled: true },
    quietMode: { enabled: true },
  },
};

const db = createDb(url)!;
try {
  const applied = await runMigrations(db);
  if (applied.length) console.log(`✔ Applied migrations: ${applied.join(', ')}`);
  const config = new ConfigService(db, { reloadMs: 60000 });
  await config.load();
  const off = process.argv.includes('--off');
  const r = await config.setOverrides(off ? {} : DEMO, 'demo-setup', off ? 'demo mode off: defaults restored' : 'team demo: show every feature');
  const c = r.effective;
  console.log(`✔ Config v${r.version}: demo mode ${off ? 'OFF' : 'ON'}`);
  console.log(`  suggestions ${c.enabled ? 'on' : 'off'} · rollout ${c.rolloutPercent}% · card languages ${c.classifier.languages.join(', ')}`);
  console.log(`  voice preview ${c.v2.previewMode.enabled ? 'on' : 'off'} · quiet mode ${c.v2.quietMode.enabled ? 'on' : 'off'}`);
  if (!off) {
    console.log('\nNext:');
    console.log('  npm run demo            app + real Groq (needs GROQ_API_KEY in .env; free tier is fine for a small demo)');
    console.log('  npm run demo:offline    app + a built-in fake Groq (no key, no limits, scripted answers)');
    console.log('  Open http://localhost:5173 in Chrome · sign in as "admin" for the analytics dashboard · script: docs/DEMO.md');
  }
} finally {
  await db.close();
}
