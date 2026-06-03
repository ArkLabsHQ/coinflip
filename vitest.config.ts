import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Vitest config for the Vue client (`src/`). The app itself is built by
 * vue-cli/webpack; Vitest runs independently with its own esbuild transform.
 *
 * - jsdom env gives client tests `localStorage` / `window` / `document` so the
 *   browser-context helpers (esplora migration, clipboard fallback) are
 *   testable without a real browser.
 * - The `@/` alias mirrors tsconfig.json's paths so imports resolve the same
 *   way they do in the app.
 * - Client tests use the `.spec.ts` suffix to stay distinct from the
 *   packages/e2e `.test.ts` jest suite.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
