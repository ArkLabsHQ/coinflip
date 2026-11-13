export const BANKROLL_SHARE_UNITS_PER_SAT = 1_000_000n

export type BankrollPhase = 'admission' | 'open' | 'closing' | 'closed'
export type BankrollOutcome = 'house' | 'player' | 'refund'

export interface BankrollWager {
  readonly id: string
  readonly houseStakeSats: bigint
  readonly playerStakeSats: bigint
  readonly status: 'reserved' | 'funded' | 'settled' | 'released'
  readonly outcome?: BankrollOutcome
}

export interface BankrollState {
  readonly phase: BankrollPhase
  readonly epoch: bigint
  readonly version: bigint
  readonly navSats: bigint
  readonly liquidSats: bigint
  readonly totalShares: bigint
  readonly carriedLossSats: bigint
  readonly openingNavSats: bigint | null
  readonly operatorFeeBps: bigint
  readonly maxStakeBps: bigint
  readonly minimumLiquiditySats: bigint
  readonly wagers: readonly BankrollWager[]
}

export interface BankrollOptions {
  initialSats: bigint
  operatorFeeBps: bigint
  maxStakeBps?: bigint
  minimumLiquiditySats?: bigint
}

function amount(value: bigint, name: string, allowZero = false): void {
  if (typeof value !== 'bigint' || value < 0n || (!allowZero && value === 0n)) {
    throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} bigint`)
  }
}

function requirePhase(state: BankrollState, expected: BankrollPhase): void {
  if (state.phase !== expected) throw new Error(`Bankroll must be in ${expected} phase`)
}

function next(state: BankrollState, patch: Partial<BankrollState>): BankrollState {
  return Object.freeze({ ...state, ...patch, version: state.version + 1n })
}

function pending(state: BankrollState): boolean {
  return state.wagers.some(w => w.status === 'reserved' || w.status === 'funded')
}

function requireActive(state: BankrollState): void {
  if (state.phase !== 'open' && state.phase !== 'closing') throw new Error('Bankroll epoch is not active')
}

function wager(state: BankrollState, id: string, status: BankrollWager['status']): BankrollWager {
  const found = state.wagers.find(w => w.id === id)
  if (!found) throw new Error(`Unknown wager: ${id}`)
  if (found.status !== status) throw new Error(`Wager must be ${status}: ${id}`)
  return found
}

function updateWager(state: BankrollState, changed: BankrollWager): readonly BankrollWager[] {
  return Object.freeze(state.wagers.map(w => w.id === changed.id ? Object.freeze(changed) : w))
}

function reservedSats(state: BankrollState): bigint {
  return state.wagers.reduce((sum, w) => sum + (w.status === 'reserved' ? w.houseStakeSats : 0n), 0n)
}

export function createBankroll(options: BankrollOptions): BankrollState {
  const { initialSats, operatorFeeBps, maxStakeBps = 1000n, minimumLiquiditySats = 0n } = options
  amount(initialSats, 'initialSats')
  amount(operatorFeeBps, 'operator fee', true)
  amount(maxStakeBps, 'max stake')
  amount(minimumLiquiditySats, 'minimum liquidity', true)
  if (operatorFeeBps > 10_000n) throw new Error('Operator fee exceeds 100%')
  if (maxStakeBps > 10_000n) throw new Error('Maximum stake exceeds 100%')
  if (minimumLiquiditySats > initialSats) throw new Error('Minimum liquidity exceeds initial bankroll')
  return Object.freeze({
    phase: 'admission', epoch: 0n, version: 0n,
    navSats: initialSats, liquidSats: initialSats,
    totalShares: initialSats * BANKROLL_SHARE_UNITS_PER_SAT,
    carriedLossSats: 0n, openingNavSats: null,
    operatorFeeBps, maxStakeBps, minimumLiquiditySats, wagers: Object.freeze([]),
  })
}

export function availableLiquidity(state: BankrollState): bigint {
  if (state.phase === 'closed') return 0n
  return state.liquidSats - reservedSats(state) - state.minimumLiquiditySats
}

export function quoteDeposit(state: BankrollState, sats: bigint): bigint {
  requirePhase(state, 'admission')
  amount(sats, 'deposit')
  if (state.navSats === 0n || state.totalShares === 0n) throw new Error('Bankroll is insolvent')
  return sats * state.totalShares / state.navSats
}

export function subscribe(state: BankrollState, sats: bigint, minShares = 1n): { state: BankrollState; mintedShares: bigint } {
  amount(minShares, 'minimum shares')
  const mintedShares = quoteDeposit(state, sats)
  if (mintedShares === 0n) throw new Error('Deposit mints zero shares')
  if (mintedShares < minShares) throw new Error('Deposit is below minimum shares')
  return {
    state: next(state, { navSats: state.navSats + sats, liquidSats: state.liquidSats + sats, totalShares: state.totalShares + mintedShares }),
    mintedShares,
  }
}

export function quoteRedemption(state: BankrollState, shares: bigint): bigint {
  requirePhase(state, 'admission')
  amount(shares, 'shares')
  if (shares > state.totalShares) throw new Error('Redemption exceeds share supply')
  return shares * state.navSats / state.totalShares
}

export function redeem(state: BankrollState, shares: bigint, minSats = 1n): { state: BankrollState; payoutSats: bigint } {
  amount(minSats, 'minimum sats')
  const payoutSats = quoteRedemption(state, shares)
  if (payoutSats === 0n) throw new Error('Redemption pays zero sats')
  if (payoutSats < minSats) throw new Error('Redemption is below minimum sats')
  const totalShares = state.totalShares - shares
  const navSats = state.navSats - payoutSats
  if (totalShares > 0n && navSats < state.minimumLiquiditySats) throw new Error('Redemption breaches minimum liquidity')
  const carriedLossSats = totalShares === 0n ? 0n
    : (state.carriedLossSats * totalShares + state.totalShares - 1n) / state.totalShares
  return {
    state: next(state, { totalShares, navSats, liquidSats: navSats, carriedLossSats, phase: totalShares === 0n ? 'closed' : 'admission' }),
    payoutSats,
  }
}

export function openEpoch(state: BankrollState): BankrollState {
  requirePhase(state, 'admission')
  if (state.navSats === 0n) throw new Error('Bankroll is insolvent')
  return next(state, { phase: 'open', epoch: state.epoch + 1n, openingNavSats: state.navSats, wagers: Object.freeze([]) })
}

export function reserveWager(state: BankrollState, id: string, houseStakeSats: bigint, playerStakeSats: bigint): BankrollState {
  requirePhase(state, 'open')
  if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new Error('Invalid wager identifier')
  if (state.wagers.some(w => w.id === id)) throw new Error('Wager identifier already used in this epoch')
  amount(houseStakeSats, 'house stake')
  amount(playerStakeSats, 'player stake')
  if (houseStakeSats > state.navSats * state.maxStakeBps / 10_000n) throw new Error('Wager exceeds stake limit')
  if (houseStakeSats > availableLiquidity(state)) throw new Error('Insufficient available liquidity')
  const entry = Object.freeze({ id, houseStakeSats, playerStakeSats, status: 'reserved' as const })
  return next(state, { wagers: Object.freeze([...state.wagers, entry]) })
}

export function releaseWager(state: BankrollState, id: string): BankrollState {
  requireActive(state)
  const entry = wager(state, id, 'reserved')
  return next(state, { wagers: updateWager(state, { ...entry, status: 'released' }) })
}

export function fundWager(state: BankrollState, id: string): BankrollState {
  requireActive(state)
  const entry = wager(state, id, 'reserved')
  return next(state, { liquidSats: state.liquidSats - entry.houseStakeSats, wagers: updateWager(state, { ...entry, status: 'funded' }) })
}

export function settleWager(state: BankrollState, id: string, outcome: BankrollOutcome, costsSats = 0n): BankrollState {
  requireActive(state)
  const entry = wager(state, id, 'funded')
  amount(costsSats, 'costs', true)
  if (outcome !== 'house' && outcome !== 'player' && outcome !== 'refund') throw new Error('Invalid wager outcome')
  const returned = outcome === 'house' ? entry.houseStakeSats + entry.playerStakeSats
    : outcome === 'refund' ? entry.houseStakeSats : 0n
  const liquidSats = state.liquidSats + returned - costsSats
  if (liquidSats < reservedSats(state) + state.minimumLiquiditySats) throw new Error('Costs breach reserved liquidity')
  return next(state, {
    navSats: state.navSats - entry.houseStakeSats + returned - costsSats, liquidSats,
    wagers: updateWager(state, { ...entry, status: 'settled', outcome }),
  })
}

export function beginClose(state: BankrollState): BankrollState {
  requirePhase(state, 'open')
  return next(state, { phase: 'closing' })
}

export function closeEpoch(state: BankrollState): { state: BankrollState; operatorFeeSats: bigint; pnlSats: bigint } {
  requirePhase(state, 'closing')
  if (pending(state)) throw new Error('Cannot close an epoch with pending wagers')
  if (state.openingNavSats === null) throw new Error('Missing opening NAV')
  const pnlSats = state.navSats - state.openingNavSats
  const feeable = pnlSats > state.carriedLossSats ? pnlSats - state.carriedLossSats : 0n
  const operatorFeeSats = feeable * state.operatorFeeBps / 10_000n
  const carriedLossSats = state.carriedLossSats > pnlSats ? state.carriedLossSats - pnlSats : 0n
  const navSats = state.navSats - operatorFeeSats
  return {
    state: next(state, { phase: 'admission', navSats, liquidSats: navSats, carriedLossSats, openingNavSats: null }),
    operatorFeeSats, pnlSats,
  }
}
