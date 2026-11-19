import type { Platform } from '@svs/shared';

export const APP_VERSION = '0.1.0';

/** One id per browser tab, used as the event `session_id`. */
export const TAB_SESSION_ID: string = (() => {
  try {
    const existing = sessionStorage.getItem('svs_tab_session');
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem('svs_tab_session', id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
})();

export const currentPlatform = (): Platform => (window.matchMedia('(max-width: 767px)').matches ? 'web-mobile' : 'web-desktop');
