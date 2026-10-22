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
    proxy: {
      '/api': server,
      '/mqtt': { target: server, ws: true },
      '/healthz': server,
    },
  },
});
