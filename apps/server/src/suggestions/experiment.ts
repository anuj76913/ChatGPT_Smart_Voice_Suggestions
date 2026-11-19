import type { Arm, SvsConfig } from '@svs/shared';
import { bucketOf } from '../config/gate';
import type { Queryable } from '../db';

/**
 * S6 Experiment Assignment (architecture §11). Deterministic: the same (user, experiment) always hashes to the same
 * arm, and the first assignment is persisted so later changes to the split never move an existing user (EX-08).
 */
export function armFor(userId: string, cfg: SvsConfig): Arm {
  return bucketOf(`arm:${cfg.experiment.id}:${userId}`) < Math.round(cfg.experiment.treatmentShare * 10000) ? 'treatment' : 'control';
}

export async function assignArm(db: Queryable, userId: string, cfg: SvsConfig): Promise<Arm> {
  const arm = armFor(userId, cfg);
  await db.query(
    'INSERT INTO experiment_assignments (user_id, experiment_id, arm) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [userId, cfg.experiment.id, arm],
  );
  const { rows } = await db.query<{ arm: Arm }>('SELECT arm FROM experiment_assignments WHERE user_id = $1 AND experiment_id = $2', [userId, cfg.experiment.id]);
  return rows[0]?.arm ?? arm;
}
