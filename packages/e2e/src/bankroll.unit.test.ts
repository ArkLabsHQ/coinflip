import type { BankrollOutcome, BankrollState } from 'arkade-coinflip/dist/bankroll'

const {
  createBankroll, availableLiquidity, quoteDeposit, quoteRedemption,
  subscribe, redeem, openEpoch, beginClose, closeEpoch,
  reserveWager, releaseWager, fundWager, settleWager,
} = require('arkade-coinflip/dist/bankroll.js')

const initial = (initialSats = 100_000n, operatorFeeBps = 2000n) =>
  createBankroll({ initialSats, operatorFeeBps, maxStakeBps: 10_000n })

function game(state: BankrollState, id: string, house: bigint, player: bigint, outcome: BankrollOutcome, costs = 0n) {
  return settleWager(fundWager(reserveWager(state, id, house, player), id), id, outcome, costs)
}

describe('community bankroll accounting', () => {
  it('issues proportional shares and preserves membership value on subscriptions', () => {
    const seed = initial()
    expect(seed.totalShares).toBe(100_000_000_000n)
    expect(quoteDeposit(seed, 25_000n)).toBe(25_000_000_000n)
    const joined = subscribe(seed, 25_000n)
    expect(joined.mintedShares).toBe(25_000_000_000n)
    expect(quoteRedemption(joined.state, seed.totalShares)).toBe(100_000n)
    expect(seed.navSats).toBe(100_000n)
    expect(joined.state.version).toBe(seed.version + 1n)
  })

  it('shares gaming gains through NAV and charges commission only after settlement', () => {
    const seed = initial()
    const played = game(openEpoch(seed), 'win', 10_000n, 10_000n, 'house', 100n)
    expect(played.navSats).toBe(109_900n)
    const closed = closeEpoch(beginClose(played))
    expect(closed.pnlSats).toBe(9900n)
    expect(closed.operatorFeeSats).toBe(1980n)
    expect(closed.state.navSats).toBe(107_920n)
    expect(quoteRedemption(closed.state, seed.totalShares)).toBe(107_920n)
  })

  it('recovers past losses before charging the operator', () => {
    const lost = closeEpoch(beginClose(game(openEpoch(initial()), 'loss', 10_000n, 10_000n, 'player')))
    expect(lost.state.navSats).toBe(90_000n)
    expect(lost.state.carriedLossSats).toBe(10_000n)
    expect(lost.operatorFeeSats).toBe(0n)
    const recovered = closeEpoch(beginClose(game(openEpoch(lost.state), 'gain', 15_000n, 15_000n, 'house')))
    expect(recovered.operatorFeeSats).toBe(1000n)
    expect(recovered.state.navSats).toBe(104_000n)
    expect(recovered.state.carriedLossSats).toBe(0n)
  })

  it('does not count subscriptions or redemptions as operating profit', () => {
    const lost = closeEpoch(beginClose(game(openEpoch(initial()), 'loss', 10_000n, 10_000n, 'player'))).state
    const joined = subscribe(lost, 90_000n).state
    expect(joined.carriedLossSats).toBe(10_000n)
    const exited = redeem(joined, joined.totalShares / 2n).state
    expect(exited.carriedLossSats).toBe(5000n)
    const closed = closeEpoch(beginClose(openEpoch(exited)))
    expect(closed.pnlSats).toBe(0n)
    expect(closed.operatorFeeSats).toBe(0n)
    expect(closed.state.carriedLossSats).toBe(5000n)
  })

  it('returns only house principal on a cancelled funded game', () => {
    const closed = closeEpoch(beginClose(game(openEpoch(initial()), 'refund', 10_000n, 20_000n, 'refund')))
    expect(closed.state.navSats).toBe(100_000n)
    expect(closed.pnlSats).toBe(0n)
    expect(closed.operatorFeeSats).toBe(0n)
  })

  it('holds reserved and funded stakes without overcommitting liquidity', () => {
    const state = reserveWager(openEpoch(initial()), 'one', 60_000n, 1000n)
    expect(availableLiquidity(state)).toBe(40_000n)
    expect(() => reserveWager(state, 'two', 40_001n, 1000n)).toThrow(/liquidity/)
    const funded = fundWager(state, 'one')
    expect(funded.liquidSats).toBe(40_000n)
    expect(funded.navSats).toBe(100_000n)
    expect(availableLiquidity(funded)).toBe(40_000n)
    expect(() => releaseWager(funded, 'one')).toThrow(/reserved/)
    const settled = settleWager(funded, 'one', 'player')
    expect(settled.liquidSats).toBe(settled.navSats)
  })

  it('requires a funded wager before recognizing its outcome, once', () => {
    const reserved = reserveWager(openEpoch(initial()), 'one', 1000n, 1000n)
    expect(() => settleWager(reserved, 'one', 'house')).toThrow(/funded/)
    const settled = settleWager(fundWager(reserved, 'one'), 'one', 'house')
    expect(() => settleWager(settled, 'one', 'house')).toThrow(/funded/)
    expect(() => reserveWager(settled, 'one', 1000n, 1000n)).toThrow(/already/)
    expect(() => fundWager(settled, 'missing')).toThrow(/Unknown/)
  })

  it('blocks admission and close while exposure remains and permits finishing during close', () => {
    const pending = reserveWager(openEpoch(initial()), 'one', 1000n, 1000n)
    expect(() => subscribe(pending, 1000n)).toThrow(/admission/)
    expect(() => redeem(pending, 1_000_000n)).toThrow(/admission/)
    expect(() => closeEpoch(pending)).toThrow(/closing/)
    const closing = beginClose(pending)
    expect(() => reserveWager(closing, 'two', 1000n, 1000n)).toThrow(/open/)
    expect(() => closeEpoch(closing)).toThrow(/pending/)
    const done = settleWager(fundWager(closing, 'one'), 'one', 'refund')
    expect(closeEpoch(done).state.phase).toBe('admission')
  })

  it('can release a setup reservation, keeping principal and refusing a late funding retry', () => {
    const released = releaseWager(reserveWager(openEpoch(initial()), 'one', 1000n, 1000n), 'one')
    expect(availableLiquidity(released)).toBe(100_000n)
    expect(() => fundWager(released, 'one')).toThrow(/reserved/)
    expect(closeEpoch(beginClose(released)).pnlSats).toBe(0n)
  })

  it('enforces stake limits, minimum liquidity and fee budgets before accounting a spend', () => {
    const state = openEpoch(createBankroll({ initialSats: 100_000n, operatorFeeBps: 2000n, maxStakeBps: 1000n, minimumLiquiditySats: 95_000n }))
    expect(() => reserveWager(state, 'limit', 10_001n, 1000n)).toThrow(/stake limit/)
    expect(() => reserveWager(state, 'liquid', 5001n, 1000n)).toThrow(/liquidity/)
    const funded = fundWager(reserveWager(state, 'one', 5000n, 1000n), 'one')
    expect(() => settleWager(funded, 'one', 'player', 1n)).toThrow(/liquidity/)
  })

  it('retires all supply with the final redemption and leaves no orphan NAV', () => {
    const seed = initial()
    const closed = redeem(seed, seed.totalShares)
    expect(closed.payoutSats).toBe(100_000n)
    expect(closed.state.phase).toBe('closed')
    expect(closed.state.totalShares).toBe(0n)
    expect(closed.state.navSats).toBe(0n)
    expect(availableLiquidity(closed.state)).toBe(0n)
    expect(() => openEpoch(closed.state)).toThrow(/admission/)
    expect(() => subscribe(closed.state, 1000n)).toThrow(/admission/)
  })

  it('rejects recapitalization at a zero NAV while outstanding shares remain', () => {
    const busted = closeEpoch(beginClose(game(openEpoch(initial(1000n)), 'all', 1000n, 1000n, 'player'))).state
    expect(busted.navSats).toBe(0n)
    expect(() => subscribe(busted, 1000n)).toThrow(/insolvent/)
    expect(() => openEpoch(busted)).toThrow(/insolvent/)
    expect(() => redeem(busted, busted.totalShares)).toThrow(/zero/)
  })

  it('rounds payouts down, protects carried losses and honors member minimums', () => {
    const seed = initial(3n, 0n)
    expect(quoteRedemption(seed, 1n)).toBe(0n)
    expect(() => redeem(seed, 1n)).toThrow(/zero/)
    expect(() => subscribe(seed, 1n, 1_000_001n)).toThrow(/minimum/)
    expect(() => redeem(seed, 1_000_000n, 2n)).toThrow(/minimum/)
    const lost = closeEpoch(beginClose(game(openEpoch(initial(3n, 0n)), 'loss', 1n, 1n, 'player'))).state
    const withdrawn = redeem(lost, lost.totalShares / 2n)
    expect(withdrawn.payoutSats).toBe(1n)
    expect(withdrawn.state.carriedLossSats).toBe(1n)
  })

  it('does not lose precision above the JavaScript safe integer range', () => {
    const seed = initial(9_007_199_254_740_993n)
    expect(quoteDeposit(seed, 9_007_199_254_740_993n)).toBe(seed.totalShares)
    const doubled = subscribe(seed, seed.navSats).state
    expect(redeem(doubled, doubled.totalShares / 2n).payoutSats).toBe(seed.navSats)
  })

  it.each([0n, -1n, 1, NaN, Infinity, '1000', null])('rejects non-positive or non-bigint amounts: %s', (amount) => {
    expect(() => createBankroll({ initialSats: amount, operatorFeeBps: 2000n })).toThrow()
    expect(() => subscribe(initial(), amount)).toThrow()
  })

  it('validates rates, identifiers and outcomes at its public boundary', () => {
    expect(() => initial(1000n, -1n)).toThrow(/fee/)
    expect(() => initial(1000n, 10_001n)).toThrow(/fee/)
    expect(() => createBankroll({ initialSats: 1000n, operatorFeeBps: 2000n, maxStakeBps: 0n })).toThrow(/stake/)
    expect(() => reserveWager(openEpoch(initial()), '', 1000n, 1000n)).toThrow(/identifier/)
    const funded = fundWager(reserveWager(openEpoch(initial()), 'one', 1000n, 1000n), 'one')
    expect(() => settleWager(funded, 'one', 'unknown')).toThrow(/outcome/)
    expect(() => settleWager(funded, 'one', 'house', -1n)).toThrow(/cost/)
  })
})

export {}
