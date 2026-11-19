/**
 * Anonymous identity for the prototype: no name is asked. Each browser gets a random learner handle, kept in
 * localStorage so conversations and streaks survive a reload. Storage can be blocked (private windows), in
 * which case the handle lasts for this page load only.
 */
export const ADMIN_ROUTE = '#/admin/analytics';
const ADMIN_KEY = 'svs_admin_handle';

/**
 * The admin handle (must be listed in the server's ADMIN_USERS), or null when this browser has none.
 * - Local development: VITE_ADMIN_HANDLE or "admin", so #/admin/analytics just works.
 * - A deployed (public) build never contains it: open the private link /?admin=<handle>#/admin/analytics once;
 *   the handle is kept for this browser tab and removed from the address bar. Without it, the dashboard URL
 *   stays a normal learner chat, so strangers can't become admin and change the live config.
 */
export function adminHandle(): string | null {
  try {
    const url = new URL(location.href);
    const fromLink = url.searchParams.get('admin');
    if (fromLink && /^[a-z0-9._-]{2,32}$/i.test(fromLink)) {
      sessionStorage.setItem(ADMIN_KEY, fromLink);
      url.searchParams.delete('admin');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      return fromLink;
    }
    const saved = sessionStorage.getItem(ADMIN_KEY);
    if (saved) return saved;
  } catch {
    /* storage blocked: fall through */
  }
  return import.meta.env.DEV ? ((import.meta.env.VITE_ADMIN_HANDLE as string | undefined) ?? 'admin') : null;
}

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
