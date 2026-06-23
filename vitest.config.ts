import { defineConfig, configDefaults } from 'vitest/config'
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
 * - `*.live.spec.ts` is EXCLUDED here: those drive a real connect against the
 *   local regtest stack and can't run in CI. Run them via `npm run test:live`
 *   (vitest.live.config.ts), which also tolerates the SDK stream's jsdom noise.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
    exclude: [...configDefaults.exclude, '**/*.live.spec.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
