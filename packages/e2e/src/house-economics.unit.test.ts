import { computeHouseStake, foldSubDustStake, quoteCommittedEconomics, quotePoolEconomics } from 'arkade-coinflip'

describe('committed game economics', () => {
  const even = { playerStake: 10_000, houseStake: 9700, oddsN: 2, oddsTarget: 1, oddsLo: 0 }

  it('reports the actual 1.5% edge of a 300-bps discounted house stake at even odds', () => {
    expect(computeHouseStake(10_000, 2, 1, 0, 300)).toBe(9700)
    const quote = quoteCommittedEconomics({ ...even, configuredHouseStakeDiscountBps: 300 })
    expect(quote).toEqual({ playerStake: 10_000, houseStake: 9700, pot: 19_700, rakeAmount: 0,
      winProbability: { numerator: '1', denominator: '2' },
      expectedHouseProfitSats: { numerator: '150', denominator: '1' },
      effectiveHouseEdgeBps: { numerator: '150', denominator: '1' },
      configuredHouseStakeDiscountBps: 300, basis: 'committed-stakes-before-network-costs' })
    expect(() => JSON.stringify(quote)).not.toThrow()
  })

  it('uses the winning band width and reports a 2.7% edge at a 10% win probability', () => {
    const houseStake = computeHouseStake(10_000, 100, 80, 70, 300)
    expect(houseStake).toBe(87_300)
    expect(quoteCommittedEconomics({ playerStake: 10_000, houseStake, oddsN: 100, oddsTarget: 80, oddsLo: 70 }))
      .toMatchObject({ pot: 97_300, winProbability: { numerator: '1', denominator: '10' },
        expectedHouseProfitSats: { numerator: '270', denominator: '1' },
        effectiveHouseEdgeBps: { numerator: '270', denominator: '1' } })
  })

  it('retains fractional expected sats and exact reduced basis points after stake rounding', () => {
    const houseStake = computeHouseStake(1001, 2, 1, 0, 300)
    expect(houseStake).toBe(970)
    expect(quoteCommittedEconomics({ ...even, playerStake: 1001, houseStake })).toMatchObject({
      expectedHouseProfitSats: { numerator: '31', denominator: '2' },
      effectiveHouseEdgeBps: { numerator: '155000', denominator: '1001' },
    })
  })

  it('reports a post-fold subsidy without changing normal pricing and refuses it for pool wagers', () => {
    const stake = computeHouseStake(1000, 2, 1, 0, 300)
    const houseStake = foldSubDustStake(stake, 1300, 330)
    const terms = { ...even, playerStake: 1000, houseStake }
    expect(houseStake).toBe(1300)
    expect(quoteCommittedEconomics(terms)).toMatchObject({ pot: 2300,
      expectedHouseProfitSats: { numerator: '-150', denominator: '1' },
      effectiveHouseEdgeBps: { numerator: '-1500', denominator: '1' } })
    expect(() => quotePoolEconomics(terms)).toThrow(/negative expected house profit/)
  })

  it('keeps classic equal stakes fair and permits zero-edge pool quotes', () => {
    const terms = { ...even, playerStake: 1000, houseStake: 1000 }
    expect(quotePoolEconomics(terms)).toEqual(quoteCommittedEconomics(terms))
    expect(quotePoolEconomics(terms)).toMatchObject({ pot: 2000, configuredHouseStakeDiscountBps: null,
      expectedHouseProfitSats: { numerator: '0', denominator: '1' },
      effectiveHouseEdgeBps: { numerator: '0', denominator: '1' } })
  })

  it('does not report the configured discount as an effective edge after a house top-up erases it', () => {
    const terms = { ...even, houseStake: 10_000, configuredHouseStakeDiscountBps: 300 }
    expect(quotePoolEconomics(terms)).toMatchObject({ configuredHouseStakeDiscountBps: 300,
      effectiveHouseEdgeBps: { numerator: '0', denominator: '1' } })
  })

  it.each([
    { playerStake: 0 }, { playerStake: -1 }, { playerStake: 1.5 }, { houseStake: -1 },
    { houseStake: Number.NaN }, { houseStake: Number.POSITIVE_INFINITY },
    { playerStake: Number.MAX_SAFE_INTEGER, houseStake: 1 },
  ])('rejects invalid or unsafe committed amounts %p', invalid => {
    expect(() => quoteCommittedEconomics({ ...even, ...invalid })).toThrow(/safe whole sats/)
  })

  it.each([
    { oddsN: 1 }, { oddsN: 129 }, { oddsN: 2.5 }, { oddsLo: -1 },
    { oddsLo: 1, oddsTarget: 1 }, { oddsTarget: 3 }, { oddsTarget: 0.5 },
  ])('rejects invalid committed odds %p', invalid => {
    expect(() => quoteCommittedEconomics({ ...even, ...invalid })).toThrow(/Committed odds/)
  })

  it.each([-1, 10_001, 1.5, Number.NaN])('rejects an invalid reported discount %p', configuredHouseStakeDiscountBps => {
    expect(() => quoteCommittedEconomics({ ...even, configuredHouseStakeDiscountBps })).toThrow(/basis points/)
  })
})
