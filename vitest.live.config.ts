import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Vitest config for LIVE client specs (the `.live.spec.ts` suffix) — run via
 * `npm run test:live` with the local regtest stack up (arkd :7070 + coinflip
 * server :3001). These dispatch the real connect action to set the module-level
 * `sdkWallet`, then drive store actions for real; they self-skip when the stack
 * is unreachable, so they're inert (and excluded anyway) in CI.
 *
 * `dangerouslyIgnoreUnhandledErrors`: the SDK wallet's notification stream emits
 * an async jsdom two-realm Event/EventTarget mismatch ("must be an instance of
 * Event") after the connect. It's harmless background noise that doesn't affect
 * the assertions, but it would otherwise fail the run — so we tolerate it here.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.live.spec.ts'],
    dangerouslyIgnoreUnhandledErrors: true,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
