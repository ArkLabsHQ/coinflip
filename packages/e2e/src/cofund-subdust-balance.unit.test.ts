/**
 * Co-fund balance invariant + the sub-dust-change fold.
 *
 * arkd rejects an offchain tx whose inputs != outputs ("input amount is not equal to
 * output amount"). `jointPotCofundOutputs` drops any change <= dust (a dust output
 * can't exist) — so a player VTXO that leaves a sub-dust change USED to unbalance the
 * co-fund by exactly that change (the prod mutinynet co-fund 500s). The fix folds the
 * sub-dust remainder into the stake: the server sets playerStake = tier + topUp (pot
 * grows to match), and the client stakes its full VTXO so the change becomes 0.
 *
 * This pins the balance: sum(outputs) must equal sum(player+house inputs).
 */
/* eslint-disable @typescript-eslint/no-require-imports */
export {}
const { jointPotCofundOutputs } = require('arkade-coinflip')

const p2tr = (b: number): Uint8Array => new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(b)])
const sum = (outs: { amount: bigint }[]): bigint => outs.reduce((s, o) => s + o.amount, 0n)

const DUST = 546n
const TIER = 1000n
const PLAYER_VTXO = TIER + 23n // 1023 — leaves a 23-sat (sub-dust) change at the tier
const HOUSE_VTXO = 5000n

describe('co-fund sub-dust-change fold — balance invariant', () => {
  it('FOLDED: staking the sub-dust remainder keeps inputs == outputs', () => {
    // Server folded topUp=23 into the stake: playerStake=1023, houseStake scales to
    // 1023 (even odds), pot=2046. Client stakes its full VTXO → playerChange = 0.
    const playerStake = PLAYER_VTXO // 1023
    const houseStake = 1023n
    const pot = playerStake + houseStake // 2046
    const outs = jointPotCofundOutputs({
      potPkScript: p2tr(0x01), potAmount: pot,
      playerChangePkScript: p2tr(0x0a), playerChange: PLAYER_VTXO - playerStake, // 0
      houseChangePkScript: p2tr(0x0b), houseChange: HOUSE_VTXO - houseStake, // 3977
      dust: DUST,
    })
    expect(sum(outs)).toBe(PLAYER_VTXO + HOUSE_VTXO) // 6023 == 6023 ✅ balanced
  })

  it('UNFOLDED (the bug): a sub-dust player change is dropped → tx is short by that change', () => {
    // The old behaviour: playerStake=tier(1000), houseStake=1000-ish, pot=2000-ish,
    // playerChange = 1023-1000 = 23 <= dust → DROPPED, its sats vanish from the outputs.
    const playerStake = TIER // 1000
    const houseStake = 1023n
    const pot = playerStake + houseStake // 2023
    const outs = jointPotCofundOutputs({
      potPkScript: p2tr(0x01), potAmount: pot,
      playerChangePkScript: p2tr(0x0a), playerChange: PLAYER_VTXO - playerStake, // 23 (sub-dust)
      houseChangePkScript: p2tr(0x0b), houseChange: HOUSE_VTXO - houseStake, // 3977
      dust: DUST,
    })
    // Only pot + houseChange survive; the 23-sat playerChange is gone.
    expect(sum(outs)).toBe(pot + (HOUSE_VTXO - houseStake)) // 6000
    expect(PLAYER_VTXO + HOUSE_VTXO - sum(outs)).toBe(23n) // 6023 - 6000 = 23-sat imbalance
  })

  it('a NON-sub-dust change is still emitted normally (fold only triggers <= dust)', () => {
    // Player VTXO leaves a 4000-sat change (> dust) → normal change output, balanced.
    const bigVtxo = TIER + 4000n // 5000
    const houseStake = 1000n
    const outs = jointPotCofundOutputs({
      potPkScript: p2tr(0x01), potAmount: TIER + houseStake,
      playerChangePkScript: p2tr(0x0a), playerChange: bigVtxo - TIER, // 4000 > dust
      houseChangePkScript: p2tr(0x0b), houseChange: HOUSE_VTXO - houseStake, // 4000
      dust: DUST,
    })
    expect(outs).toHaveLength(3) // pot + player change + house change
    expect(sum(outs)).toBe(bigVtxo + HOUSE_VTXO) // balanced
  })
})
