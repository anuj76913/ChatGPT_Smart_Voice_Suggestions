import { MAX_MESSAGE_CHARS, type ClientConfig } from '@svs/shared';
import { api } from './api';

/**
 * C8 Config Cache: short-TTL copy of client-safe config (P1.9).
 * Never authoritative for the kill switch or eligibility; the server decides those on every request.
 */
const STORAGE_KEY = 'svs_client_config';
const DEFAULTS: ClientConfig = {
  ttl_seconds: 60,
  copy_languages: ['en'],
  max_message_chars: MAX_MESSAGE_CHARS,
  features: { preview_mode: false, quiet_mode: false },
};

let cached: { value: ClientConfig; fetchedAt: number } | null = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { value: ClientConfig; fetchedAt: number }) : null;
  } catch {
    return null;
  }
})();

export async function getClientConfig(): Promise<ClientConfig> {
  const fresh = cached && Date.now() - cached.fetchedAt < cached.value.ttl_seconds * 1000;
  if (fresh) return cached!.value;
  try {
    const value = await api.clientConfig();
    cached = { value, fetchedAt: Date.now() };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
    } catch {
      /* storage unavailable: memory cache still works */
    }
    return value;
  } catch {
    return cached?.value ?? DEFAULTS;
  }
}
