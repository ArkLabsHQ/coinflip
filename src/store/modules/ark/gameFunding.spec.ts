import { describe, expect, it } from 'vitest'
import type { ExtendedVirtualCoin } from '@arkade-os/sdk'
import { selectPlainGameInputs } from './walletRuntime'

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
})
