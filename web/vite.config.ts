import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The UI is on :4100 in dev and production. In dev the API server runs on :4102 (server/dev.env)
// behind this proxy, so pagers on the LAN can use the same URL too.
const server = process.env.SERVER_URL ?? 'http://localhost:4102';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4100,
    strictPort: true,
    host: true,
    // Keep the browser's Host (the shorthand form would rewrite it to the server's), so the
    // server sees the address in use, e.g. for Google's redirect URI. xfwd adds X-Forwarded-*.
    proxy: {
      '/api': { target: server, changeOrigin: false, xfwd: true },
      '/mqtt': { target: server, ws: true, changeOrigin: false, xfwd: true },
      '/healthz': server,
    },
  },
});
