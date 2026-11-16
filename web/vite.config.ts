import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  // Read API_PORT from the repo-root .env (and the real environment) so the proxy finds the API.
  const env = { ...loadEnv(mode, '..', ''), ...process.env };
  const apiPort = env.API_PORT ?? '3000';

  return {
    server: {
      port: 5173,
      proxy: {
        // The Express API (npm run dev -w server) — SSE streams pass straight through.
        '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
      },
    },
    build: { outDir: 'dist', sourcemap: true },
    test: { environment: 'node', include: ['test/**/*.test.ts'] },
  };
});
