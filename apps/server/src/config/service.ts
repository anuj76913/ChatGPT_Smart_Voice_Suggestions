import { DEFAULT_SVS_CONFIG, mergeConfig, type DeepPartial, type SvsConfig } from '@svs/shared';
import type { Db } from '../db';
import { validateConfig } from './schema';

type Overrides = DeepPartial<SvsConfig>;

export interface AuditEntry {
  id: number;
  changed_at: string;
  actor: string;
  reason: string;
  version: number;
  old_overrides: Overrides;
  new_overrides: Overrides;
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid config: ${issues.join('; ')}`);
  }
}

/** Stale-config limit: suggestions fail closed when the last good load is older than this (edge-case CF-03). */
export const MAX_CONFIG_STALENESS_MS = 5 * 60 * 1000;

/**
 * S7 Config & Kill Switch store. Effective config = defaults deep-merged with the overrides row in `svs_config`.
 * Reloads every `reloadMs` (≤1 min target), so changes apply without a release. A bad row never replaces a good config.
 */
export class ConfigService {
  private effective: SvsConfig = DEFAULT_SVS_CONFIG;
  private overrides: Overrides = {};
  private version = 0;
  private lastLoadedAt: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Db | null,
    private readonly opts: { reloadMs: number; log?: { warn: (o: object, m: string) => void; info?: (o: object, m: string) => void }; now?: () => number },
  ) {
    // Without a database the defaults are the only source of truth, so they never go stale.
    this.lastLoadedAt = this.now();
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  get(): SvsConfig {
    return this.effective;
  }

  getVersion() {
    return this.version;
  }

  getOverrides(): Overrides {
    return this.overrides;
  }

  /** False when the database copy couldn't be loaded for longer than MAX_CONFIG_STALENESS_MS. */
  isFresh(): boolean {
    return !this.db || this.now() - this.lastLoadedAt <= MAX_CONFIG_STALENESS_MS;
  }

  async load(): Promise<void> {
    if (!this.db) return;
    try {
      const { rows } = await this.db.query<{ overrides: Overrides; version: number }>('SELECT overrides, version FROM svs_config WHERE id = 1');
      const row = rows[0];
      const overrides = row?.overrides ?? {};
      const merged = mergeConfig(DEFAULT_SVS_CONFIG, overrides);
      const check = validateConfig(merged);
      if (!check.ok) {
        this.opts.log?.warn({ issues: check.issues }, 'stored config overrides are invalid; keeping the previous config');
        return;
      }
      if (row && row.version !== this.version) this.opts.log?.info?.({ version: row.version }, 'config loaded');
      this.effective = merged;
      this.overrides = overrides;
      this.version = row?.version ?? 0;
      this.lastLoadedAt = this.now();
    } catch (err) {
      this.opts.log?.warn({ err: (err as Error).message }, 'config reload failed; keeping the previous config');
    }
  }

  async start() {
    await this.load();
    this.timer = setInterval(() => void this.load(), this.opts.reloadMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Replaces the overrides (validated after merging), writes an audit row and applies immediately. */
  async setOverrides(next: Overrides, actor: string, reason: string): Promise<{ version: number; effective: SvsConfig }> {
    if (!this.db) throw new Error('config store unavailable');
    const merged = mergeConfig(DEFAULT_SVS_CONFIG, next);
    const check = validateConfig(merged);
    if (!check.ok) throw new ConfigValidationError(check.issues);
    const version = await this.db.tx(async (c) => {
      const old = await c.query<{ overrides: Overrides; version: number }>('SELECT overrides, version FROM svs_config WHERE id = 1 FOR UPDATE');
      const prev = old.rows[0]!;
      const nextVersion = prev.version + 1;
      await c.query('UPDATE svs_config SET overrides = $1, version = $2, updated_at = now(), updated_by = $3 WHERE id = 1', [
        JSON.stringify(next),
        nextVersion,
        actor,
      ]);
      await c.query(
        'INSERT INTO svs_config_audit (actor, reason, version, old_overrides, new_overrides) VALUES ($1, $2, $3, $4, $5)',
        [actor, reason, nextVersion, JSON.stringify(prev.overrides), JSON.stringify(next)],
      );
      return nextVersion;
    });
    await this.load();
    return { version, effective: this.effective };
  }

  async audit(limit = 20): Promise<AuditEntry[]> {
    if (!this.db) return [];
    const { rows } = await this.db.query<AuditEntry>(
      'SELECT id, changed_at, actor, reason, version, old_overrides, new_overrides FROM svs_config_audit ORDER BY id DESC LIMIT $1',
      [limit],
    );
    return rows;
  }
}
