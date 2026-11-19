/**
 * P0.5 Groq setup check.
 *   npm run groq:check               → verify key, list models, check every configured model ID, run a classifier smoke test
 *   npm run groq:check -- --no-smoke → skip the (billable, tiny) smoke-test completion
 *
 * Reads GROQ_API_KEY (and optional GROQ_BASE_URL) from the environment / repo-root .env.
 * The key is never printed.
 */
import { config as loadDotenv } from 'dotenv';
import { DEFAULT_SVS_CONFIG, configuredGroqModels, INTENT_LABELS } from '@svs/shared';

loadDotenv({ quiet: true });

const key = process.env.GROQ_API_KEY;
const baseUrl = (process.env.GROQ_BASE_URL ?? DEFAULT_SVS_CONFIG.llm.baseUrl).replace(/\/$/, '');
const runSmoke = !process.argv.includes('--no-smoke');

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

async function groq(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

async function main() {
  if (!key) fail('GROQ_API_KEY is not set. Add it to the repo-root .env (see docs/phase0/groq-setup.md).');

  // 1. Key works + list models
  const res = await groq('/models');
  if (res.status === 401) fail('Groq rejected the API key (401). Check that the key is correct and active.');
  if (!res.ok) fail(`GET /models failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data: Array<{ id: string; active?: boolean }> };
  const available = new Map(body.data.map((m) => [m.id, m.active !== false]));
  console.log(`✔ API key accepted. ${available.size} models visible to this key.`);

  // 2. Every configured model must exist and be active
  let missing = 0;
  console.log('\nConfigured models (packages/shared/src/config.ts):');
  for (const id of configuredGroqModels()) {
    const state = available.has(id) ? (available.get(id) ? 'ok' : 'INACTIVE') : 'MISSING';
    if (state !== 'ok') missing++;
    console.log(`  ${state === 'ok' ? '✔' : '✖'} ${id.padEnd(28)} ${state}`);
  }

  // 3. Smoke test: strict json_schema classification on the classifier model (architecture §6.1)
  let smokeOk = true;
  if (runSmoke) {
    const model = DEFAULT_SVS_CONFIG.llm.models.classifier.primary;
    const started = Date.now();
    const r = await groq('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: 200,
        reasoning_effort: DEFAULT_SVS_CONFIG.llm.reasoningEffort.classifier,
        messages: [
          {
            role: 'system',
            content:
              'Classify whether the learner wants to PRACTISE ALOUD. Labels: mock_interview, spoken_english, viva_revision, pronunciation, none. Reply with JSON only.',
          },
          { role: 'user', content: 'Mera kal TCS ka interview hai, mock interview le lo please' },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'voice_intent',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['intent', 'confidence', 'language'],
              properties: {
                intent: { type: 'string', enum: [...INTENT_LABELS] },
                confidence: { type: 'number' },
                language: { type: 'string', enum: ['en', 'hinglish', 'hi', 'other'] },
              },
            },
          },
        },
      }),
    });
    const ms = Date.now() - started;
    if (!r.ok) {
      smokeOk = false;
      console.log(`\n✖ Smoke test (${model}, strict json_schema) failed: HTTP ${r.status} ${await r.text()}`);
    } else {
      const json = (await r.json()) as { choices: Array<{ message: { content: string } }> };
      const content = json.choices[0]?.message.content ?? '';
      console.log(`\n✔ Smoke test (${model}, strict json_schema) in ${ms} ms → ${content}`);
      try {
        const parsed = JSON.parse(content) as { intent: string };
        if (parsed.intent !== 'mock_interview') console.log('  ⚠ Unexpected intent for a clear mock-interview query.');
      } catch {
        smokeOk = false;
        console.log('  ✖ Response was not valid JSON.');
      }
    }
  }

  if (missing > 0) fail(`${missing} configured model(s) are missing or inactive. Update packages/shared/src/config.ts.`);
  if (!smokeOk) fail('Smoke test failed.');
  console.log('\n✔ Groq setup looks good.');
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
