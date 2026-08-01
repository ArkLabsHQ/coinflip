/**
 * Navigation policy, kept separate from `router/index.ts` so it can be tested.
 * The router module imports `.vue` components, and the vitest config has no Vue
 * plugin, so anything reachable from there is untestable — hence this split.
 */

export interface NavTarget {
  name?: string | symbol | null
  meta?: { requiresWallet?: boolean }
}

/**
 * The path a navigation should be redirected to, or null to let it through.
 *
 * Two rules, mirroring each other:
 *
 *   - A route that needs a wallet, without one -> the setup screen.
 *   - The setup screen, with a wallet already -> the game. Setup only offers
 *     "create" and "import"; for someone who already has a wallet it's a dead
 *     end, and it's reachable by typing the URL or via a stale bookmark.
 *
 * Deleting a wallet still lands on setup: `clearWallet` is awaited before the
 * push, so the wallet is gone by the time this runs.
 *
 * Both rules must be checked against the SAME wallet state, and each rule's
 * target must satisfy the other, or they would bounce a navigation forever.
 * `redirectsAreTerminal` in the spec pins that.
 */
export function redirectFor(to: NavTarget, isWalletInitialized: boolean): string | null {
  if (to.meta?.requiresWallet && !isWalletInitialized) return '/setup'
  if (to.name === 'setup' && isWalletInitialized) return '/'
  return null
}
