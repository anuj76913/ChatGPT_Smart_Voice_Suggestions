import { randomUUID } from 'node:crypto';
import type { ClassifierLanguage, ClientEventInput, EventName, EventPropValue, IntentLabel } from '@svs/shared';
import type { Db } from '../db';

export interface Enrichment {
  userId: string;
  cohort: string | null;
  experimentId: string | null;
  arm: string | null;
}

/** S12 storage. Inserts are idempotent on event_id (duplicates are ignored, edge-case NW-09). */
export class EventStore {
  constructor(private readonly db: Db) {}

  /** Experiment assignment for the current experiment (null until Phase 3 assigns arms). */
  async enrichment(user: { id: string; cohort: string | null }, experimentId: string): Promise<Enrichment> {
    const { rows } = await this.db.query<{ arm: string }>(
      'SELECT arm FROM experiment_assignments WHERE user_id = $1 AND experiment_id = $2',
      [user.id, experimentId],
    );
    const arm = rows[0]?.arm ?? null;
    return { userId: user.id, cohort: user.cohort, experimentId: arm ? experimentId : null, arm };
  }

  /** Returns true when inserted, false when the event_id already existed. */
  async insertClient(e: ClientEventInput, en: Enrichment): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO events (event_id, event, ts, source, user_id, session_id, experiment_id, arm, cohort,
         intent_type, language, app_version, platform, props)
       VALUES ($1,$2,$3,'client',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        e.event_id,
        e.event,
        e.ts,
        en.userId,
        e.session_id,
        en.experimentId,
        en.arm,
        en.cohort,
        e.intent_type ?? null,
        e.language ?? null,
        e.app_version,
        e.platform,
        JSON.stringify(e.props ?? {}),
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Server-emitted events (suggestion_eligible, voice_session_started/completed: edge-case EX-05). */
  async emitServer(
    event: EventName,
    en: Enrichment,
    fields: { sessionId: string; intentType?: IntentLabel | null; language?: ClassifierLanguage | null; props?: Record<string, EventPropValue> },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO events (event_id, event, ts, source, user_id, session_id, experiment_id, arm, cohort,
         intent_type, language, app_version, platform, props)
       VALUES ($1,$2,now(),'server',$3,$4,$5,$6,$7,$8,$9,'server',NULL,$10)`,
      [
        randomUUID(),
        event,
        en.userId,
        fields.sessionId,
        en.experimentId,
        en.arm,
        en.cohort,
        fields.intentType ?? null,
        fields.language ?? null,
        JSON.stringify(fields.props ?? {}),
      ],
    );
  }
}
