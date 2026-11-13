export interface NavTarget {
  name?: string | symbol | null
  meta?: { requiresWallet?: boolean }
  query?: Record<string, unknown>
}

export function setupReturnTo(target: unknown): '/' | '/bankroll' {
  return target === '/bankroll' ? '/bankroll' : '/'
}

export function setupDestination(target: unknown, poolView?: unknown): '/' | { path: '/bankroll'; query: { view: 'watch' | 'pool' } } {
  return setupReturnTo(target) === '/bankroll' ? { path: '/bankroll', query: { view: poolView === 'pool' ? 'pool' : 'watch' } } : '/'
}

export function redirectFor(to: NavTarget, isWalletInitialized: boolean): string | ReturnType<typeof setupDestination> | null {
  if (to.meta?.requiresWallet && !isWalletInitialized) return '/setup'
  if (to.name === 'setup' && isWalletInitialized) return setupDestination(to.query?.returnTo, to.query?.poolView)
  return null
}
