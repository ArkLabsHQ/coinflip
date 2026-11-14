import { describe, expect, it } from 'vitest'
import type { ExtendedVirtualCoin } from '@arkade-os/sdk'
import { planGameInputs, selectPlainGameInputs } from './walletRuntime'

function coin(value: number, assetUnits?: bigint): ExtendedVirtualCoin {
  return { txid: value.toString(16).padStart(64, '0'), vout: 0, value,
    assets: assetUnits === undefined ? undefined : [{ assetId: '11'.repeat(32) + '0000', amount: assetUnits }],
  } as ExtendedVirtualCoin
}

describe('normal game funding ownership', () => {
  it('funds the actual stake from plain coins while keeping larger share carriers untouched', () => {
    const shares = coin(100_000, 10_000n), first = coin(700), second = coin(500)
    const available = [shares, second, first]
    expect(selectPlainGameInputs(available, 1000)).toEqual([first, second])
    expect(available).toEqual([shares, second, first])
  })

  it('rejects a bet when share carriers make the displayed total large but plain capital is insufficient', () => {
    expect(() => selectPlainGameInputs([coin(100_000, 1_000_000n), coin(800)], 1000))
      .toThrow('Insufficient plain spendable balance for a 1000-sat bet (have 800)')
    expect(() => selectPlainGameInputs([coin(100_000, 1n)], 1000)).toThrow(/have 0/)
  })

  it('accepts a fully covered plain stake and never spends an unrelated asset', () => {
    const plain = coin(1500)
    expect(selectPlainGameInputs([coin(9000, 7n), plain], 1000)).toEqual([plain])
  })

  it('adds a coin rather than folding sub-dust change into the stake', () => {
    const payout = coin(6794), other = coin(6795 - 6000)
    expect(planGameInputs([payout, other], 6464, 330)).toEqual({ inputs: [payout, other], stakeTopUp: 0 })
  })

  it('folds sub-dust change only when no other coin can absorb it', () => {
    const payout = coin(6794)
    expect(planGameInputs([payout], 6464, 330)).toEqual({ inputs: [payout], stakeTopUp: 330 })
    expect(planGameInputs([coin(7140)], 6464, 330)).toEqual({ inputs: [coin(7140)], stakeTopUp: 0 })
  })
})
