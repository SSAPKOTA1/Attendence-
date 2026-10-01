/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev and preview the API is proxied so the refresh cookie (Path=/api/v1/auth) stays same-origin.
const api = { '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: false } };
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api },
  test: { environment: 'jsdom', globals: true, setupFiles: ['tests/unit/setup.ts'], include: ['tests/unit/**/*.test.{ts,tsx}'] },
});
