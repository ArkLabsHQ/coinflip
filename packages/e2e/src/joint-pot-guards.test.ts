/**
 * Pure unit tests (no arkd) for the joint-pot builders' input guards.
 *
 * The potAmount guard runs before any covenant/SDK use, so a dummy pot +
 * serverUnroll cast is enough to exercise it. These protect the fund-safety
 * path: the pot is 1-input→1-output with no ark-tx fee, so the payout MUST
 * equal the pot value — a mismatch should fail loud and early (a named Error),
 * not deep in arkd as an opaque "failed to process". Mirrors v3's
 * buildForfeitClaimTransactionV3 potAmount validation.
 */
import { buildJointPotForfeitClaim, buildJointPotSettleTx, buildJointPotRefundTx } from 'arkade-coinflip'

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('joint-pot builder potAmount guards', () => {
  const cofund = { txid: '00'.repeat(32), vout: 0, value: 2000 }

  const forfeit = (potAmount: bigint) =>
    buildJointPotForfeitClaim({
      pot: {} as any,
      cofund,
      playerPayoutPkScript: new Uint8Array(34),
      potAmount,
      serverUnroll: {} as any,
    })

  it('buildJointPotForfeitClaim throws when potAmount != pot value', () => {
    expect(() => forfeit(1999n)).toThrow(/potAmount/)
  })

  it('buildJointPotForfeitClaim throws when potAmount <= 0', () => {
    expect(() => forfeit(0n)).toThrow(/potAmount/)
  })

  it('buildJointPotForfeitClaim does NOT throw the guard when potAmount == pot value', () => {
    // It will still throw later (dummy pot), but NOT the potAmount guard.
    expect(() => forfeit(2000n)).not.toThrow(/potAmount/)
  })

  const settle = (potAmount: bigint) =>
    buildJointPotSettleTx({
      pot: {} as any,
      cofund,
      winner: 'player',
      winnerPayoutPkScript: new Uint8Array(34),
      potAmount,
      playerRevealBytes: new Uint8Array(17),
      creatorRevealBytes: new Uint8Array(17),
      serverUnroll: {} as any,
    })

  it('buildJointPotSettleTx throws when potAmount != pot value', () => {
    expect(() => settle(1n)).toThrow(/potAmount/)
  })
})

describe('buildJointPotRefundTx stake guards', () => {
  const refund = (playerStake: bigint, houseStake: bigint, value: number) =>
    buildJointPotRefundTx({
      pot: {} as any,
      cofund: { txid: '00'.repeat(32), vout: 0, value },
      playerStake,
      houseStake,
      playerPayoutPkScript: new Uint8Array(34),
      housePayoutPkScript: new Uint8Array(34),
      serverUnroll: {} as any,
    })

  it('throws when the two stakes do not sum to the pot value', () => {
    expect(() => refund(1000n, 1000n, 1999)).toThrow(/must equal the pot value/)
  })

  it('throws when a stake is non-positive', () => {
    expect(() => refund(0n, 2000n, 2000)).toThrow(/positive/)
  })

  it('does NOT throw the stake guards when stakes split the pot exactly', () => {
    // Still throws later (dummy pot), but NOT the stake guards.
    expect(() => refund(1000n, 1000n, 2000)).not.toThrow(/must equal|positive/)
  })
})
