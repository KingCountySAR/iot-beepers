import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.SERVER_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/mqtt': { target: server, ws: true },
    },
  },
});
