import { useEffect, useRef, useState } from 'react';
import type { Me } from '@svs/shared';
import { AnalyticsDashboard } from './components/AnalyticsDashboard';
import { ChatApp } from './components/ChatApp';
import { api, onUnauthorized } from './lib/api';
import { events } from './lib/events';
import { ADMIN_ROUTE, adminHandle, autoAdminActive, deviceHandle, setAutoAdmin } from './lib/session-identity';

type Auth = { state: 'loading' } | { state: 'in'; me: Me } | { state: 'offline' };

/**
 * No sign-in screen: each browser gets an anonymous learner handle (stored on the device) and is signed in
 * automatically with the dev login (decisions.md ADR-010). Opening #/admin/analytics signs in as the admin
 * handle instead, and leaving the dashboard switches back to the learner.
 */
export function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'loading' });
  const [hash, setHash] = useState(location.hash);
  const authRef = useRef(auth);
  authRef.current = auth;

  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    events.start();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const wantAdmin = hash === ADMIN_ROUTE;
    const signIn = async (handle: string): Promise<Me> => {
      const me = await api.login(handle);
      setAutoAdmin(handle === adminHandle());
      return me;
    };
    const resolve = async (): Promise<Me> => {
      const current = authRef.current.state === 'in' ? authRef.current.me : await api.me().catch((err: { status?: number }) => (err?.status === 401 ? null : Promise.reject(err)));
      const admin = wantAdmin ? adminHandle() : null; // null on a public build without the private admin link
      if (!current) return signIn(admin ?? deviceHandle());
      if (admin && !current.is_admin) return signIn(admin);
      // Leaving the dashboard after an automatic admin sign-in: back to this device's learner.
      if (!wantAdmin && current.is_admin && autoAdminActive()) return signIn(deviceHandle());
      return current;
    };
    resolve()
      .then((me) => !cancelled && setAuth({ state: 'in', me }))
      .catch(() => !cancelled && setAuth({ state: 'offline' }));
    return () => {
      cancelled = true;
    };
  }, [hash]);

  useEffect(() => {
    // Session expired or revoked: sign in again silently.
    const again = () => {
      // The first load handles its own 401 (no session yet); only react once signed in.
      if (authRef.current.state !== 'in') return;
      setAutoAdmin(false);
      void api
        .login((location.hash === ADMIN_ROUTE ? adminHandle() : null) ?? deviceHandle())
        .then((me) => setAuth({ state: 'in', me }))
        .catch(() => setAuth({ state: 'offline' }));
    };
    onUnauthorized.addEventListener('unauthorized', again);
    return () => onUnauthorized.removeEventListener('unauthorized', again);
  }, []);

  if (auth.state === 'loading') return <div className="center muted">Loading…</div>;
  if (auth.state === 'offline')
    return (
      <div className="center">
        <p role="alert">
          Can't reach the server. Start it with <code>npm run demo</code> and reload.
        </p>
      </div>
    );
  // P6.3 analytics dashboard: admins only (the API enforces it too).
  if (hash === ADMIN_ROUTE && auth.me.is_admin) return <AnalyticsDashboard onClose={() => (location.hash = '')} />;
  return <ChatApp key={auth.me.id} me={auth.me} />;
}
