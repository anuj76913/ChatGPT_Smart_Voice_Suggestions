/**
 * Anonymous identity for the prototype: no name is asked. Each browser gets a random learner handle, kept in
 * localStorage so conversations and streaks survive a reload. Storage can be blocked (private windows), in
 * which case the handle lasts for this page load only.
 */
export const ADMIN_ROUTE = '#/admin/analytics';
/** Must be listed in the server's ADMIN_USERS (.env). */
export const ADMIN_HANDLE = (import.meta.env.VITE_ADMIN_HANDLE as string | undefined) ?? 'admin';

const KEY = 'svs_device_handle';
const AUTO_ADMIN_KEY = 'svs_auto_admin';
let memoryHandle: string | null = null;

function newHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `learner-${[...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8)}`;
}

export function deviceHandle(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^[a-z0-9._-]{2,32}$/i.test(saved)) return saved;
    const h = newHandle();
    localStorage.setItem(KEY, h);
    return h;
  } catch {
    return (memoryHandle ??= newHandle());
  }
}

/** Remembers that the admin session was opened automatically by the dashboard URL, so leaving it switches back. */
export function setAutoAdmin(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(AUTO_ADMIN_KEY, '1');
    else sessionStorage.removeItem(AUTO_ADMIN_KEY);
  } catch {
    /* best-effort */
  }
}

export function autoAdminActive(): boolean {
  try {
    return sessionStorage.getItem(AUTO_ADMIN_KEY) === '1';
  } catch {
    return false;
  }
}
