import { describe, it, expect } from 'vitest'
import { resolveForfeitStash, hasStashedForfeit, type ForfeitClaimable } from './forfeitStash'
import type { ForfeitResponse } from '@/services/api'

// ---------------------------------------------------------------------------
// resolveForfeitStash — the pure decision at the heart of the R1 forfeit-stash
// recovery path.
//
// BACKGROUND (why this helper exists at all):
//   The arkade-script "forfeit" leaf lets a player atomically sweep BOTH
//   escrows (house + player) to their own payout address once the game's CLTV
//   matures, WITHOUT the operator's cooperation. It is the R1-audit recovery
//   for the one bad state lazy-house-funding can produce: the house has funded
//   its escrow at the start of `/commit`, but the covenant sweep never landed
//   (emulator/arkd hiccup, crash, exhausted retries), leaving a funded-but-
//   unsettled joint pot.
//
//   Building that forfeit transaction REQUIRES the joint pot to exist, which —
//   under lazy funding (v0.3.5+) — is only true AFTER `/commit` has funded the
//   house side. So the client can only obtain a forfeit PSBT from the server in
//   the post-`/commit`-failure window. Before that window the server has no
//   house escrow and (correctly) refuses, which is surfaced to this helper as
//   `forfeit === undefined`.
//
//   This function is deliberately PURE: it takes the inputs the play flow has
//   on hand and returns either the exact stash patch to persist, or a typed
//   skip reason. Keeping the decision pure makes the security-critical checks
//   (emulator present, payout address bound to OUR change address) unit-testable
//   without standing up the whole Vuex action, the SDK, or a regtest stack.
// ---------------------------------------------------------------------------

// A well-formed forfeit response whose payout is bound to the player address
// used throughout these tests. Individual cases override single fields.
const PLAYER_CHANGE_ADDRESS = 'rark1qplayerchangeaddress'

function validForfeit(overrides: Partial<ForfeitResponse> = {}): ForfeitResponse {
  return {
    forfeitPsbt: 'cHNidP8BforfeitPsbtBytes',
    forfeitCheckpoints: ['cHNidP8BcheckpointOne', 'cHNidP8BcheckpointTwo'],
    forfeitClaimableAt: 1_900_000_000,
    payoutAddress: PLAYER_CHANGE_ADDRESS,
    potAmount: 2000,
    stakes: [1000, 1000],
    ...overrides,
  }
}

describe('resolveForfeitStash', () => {
  it('skips with reason "no-emulator" when the server reports no emulator — the forfeit leaf needs the covenant co-signer, so there is nothing to stash', () => {
    const decision = resolveForfeitStash({
      emulatorUrl: undefined,
      forfeit: validForfeit(),
      expectedPayoutAddress: PLAYER_CHANGE_ADDRESS,
      playerSecretHex: 'ff',
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'no-emulator' })
  })

  it('skips with reason "no-pot" when the forfeit attempt returned nothing — the lazy-funding case where the house has not yet escrowed, so there is no joint pot to sweep', () => {
    const decision = resolveForfeitStash({
      emulatorUrl: 'http://localhost:7073',
      forfeit: undefined,
      expectedPayoutAddress: PLAYER_CHANGE_ADDRESS,
      playerSecretHex: 'ff',
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'no-pot' })
  })

  it('refuses to stash (reason "payout-mismatch") when the forfeit pays an address that is NOT our own change address — a tampered/mis-bound PSBT must never be persisted as a recovery', () => {
    const decision = resolveForfeitStash({
      emulatorUrl: 'http://localhost:7073',
      forfeit: validForfeit({ payoutAddress: 'rark1qSOMEONE_ELSE' }),
      expectedPayoutAddress: PLAYER_CHANGE_ADDRESS,
      playerSecretHex: 'ff',
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'payout-mismatch' })
  })

  it('produces a stash patch binding the forfeit PSBT + checkpoints + CLTV to the emulator URL and player secret when everything is valid', () => {
    const decision = resolveForfeitStash({
      emulatorUrl: 'http://localhost:7073',
      forfeit: validForfeit(),
      expectedPayoutAddress: PLAYER_CHANGE_ADDRESS,
      playerSecretHex: 'deadbeef',
    })
    expect(decision).toEqual({
      kind: 'stash',
      patch: {
        forfeitPsbt: 'cHNidP8BforfeitPsbtBytes',
        forfeitCheckpoints: ['cHNidP8BcheckpointOne', 'cHNidP8BcheckpointTwo'],
        forfeitClaimableAt: 1_900_000_000,
        forfeitEmulatorUrl: 'http://localhost:7073',
        playerSecretHex: 'deadbeef',
      },
    })
  })

  it('checks emulator presence BEFORE pot presence — with neither emulator nor pot, the missing emulator is the reported reason', () => {
    const decision = resolveForfeitStash({
      emulatorUrl: undefined,
      forfeit: undefined,
      expectedPayoutAddress: PLAYER_CHANGE_ADDRESS,
      playerSecretHex: 'ff',
    })
    expect(decision).toEqual({ kind: 'skip', reason: 'no-emulator' })
  })
})

describe('hasStashedForfeit', () => {
  // A stash that holds a complete, revealed forfeit. Cases knock out one field
  // each to prove every part of the predicate is load-bearing.
  function claimable(overrides: Partial<ForfeitClaimable> = {}): ForfeitClaimable {
    return {
      revealed: true,
      forfeitPsbt: 'cHNidP8Bforfeit',
      forfeitCheckpoints: ['cHNidP8Bcp'],
      forfeitEmulatorUrl: 'http://localhost:7073',
      forfeitClaimableAt: 1_900_000_000,
      ...overrides,
    }
  }

  it('is true when revealed and all forfeit fields are present', () => {
    expect(hasStashedForfeit(claimable())).toBe(true)
  })

  it('is false when the player never revealed (only a self-refund applies)', () => {
    expect(hasStashedForfeit(claimable({ revealed: false }))).toBe(false)
  })

  it('is false without a forfeit PSBT', () => {
    expect(hasStashedForfeit(claimable({ forfeitPsbt: undefined }))).toBe(false)
  })

  it('is false when checkpoints are missing — the gap that made the old hand-rolled checks inconsistent', () => {
    expect(hasStashedForfeit(claimable({ forfeitCheckpoints: undefined }))).toBe(false)
  })

  it('is false when checkpoints are present but empty (no inputs to co-sign)', () => {
    expect(hasStashedForfeit(claimable({ forfeitCheckpoints: [] }))).toBe(false)
  })

  it('is false without the emulator submission URL', () => {
    expect(hasStashedForfeit(claimable({ forfeitEmulatorUrl: undefined }))).toBe(false)
  })

  it('is false when the claimable-at CLTV is absent', () => {
    expect(hasStashedForfeit(claimable({ forfeitClaimableAt: undefined }))).toBe(false)
  })

  it('treats forfeitClaimableAt === 0 as present (a valid, if unrealistic, absolute CLTV)', () => {
    expect(hasStashedForfeit(claimable({ forfeitClaimableAt: 0 }))).toBe(true)
  })
})
