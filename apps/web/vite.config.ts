import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8787';

/**
 * P7.4: Content-Security-Policy for the production build (the dev server needs inline scripts for hot reload).
 * Same-origin scripts, styles (+ inline style attributes React sets), API and voice WebSocket; blob: for recorded
 * audio. A meta CSP can't set frame-ancestors, so the host must also send it as a header (docs/phase7/security.md).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: wss:",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const cspMeta = (): Plugin => ({
  name: 'svs-csp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
});

export default defineConfig({
  plugins: [react(), cspMeta()],
  server: {
    port: 5173,
    // The mic (getUserMedia) needs a secure context; http://localhost counts as secure in development.
    proxy: {
      '/v1': { target: apiTarget, ws: true },
      '/healthz': apiTarget,
      '/readyz': apiTarget,
    },
  },
});
