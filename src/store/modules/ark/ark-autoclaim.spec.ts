import { describe, it, expect, vi } from 'vitest'
import ark from './ark'

// The happy-path orchestration of claimV4Forfeit (build -> sign -> POST -> stash
// update) goes through requireWalletAndKey, which reads the module-level
// `sdkWallet` singleton set only by the connect flow — so a PURE unit test can't
// reach it. That full path IS exercised by ark-recovery.live.spec.ts (a real
// connect under vitest drives both stages against the local stack; run via
// `npm run test:live`), and by the proven lib flow (v4-server-play staged forfeit)
// + the unit-tested timing (v4ClaimStage). What's reachable WITHOUT a wallet here
// are the SAFETY GUARDS that run BEFORE the wallet is touched — the highest-risk
// bit for a pot claim (no double-submit, no stuck in-flight flag).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const claimV4Forfeit = (ark as any).actions.claimV4Forfeit as (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
) => Promise<void>

describe('claimV4Forfeit safety guards', () => {
  it('refuses a second concurrent claim for the same game (in-flight mutex)', async () => {
    const commit = vi.fn()
    const state = { claimingGames: { g1: { kind: 'forfeit', mode: 'auto' } }, arkAddress: 'ark1xyz' }
    await expect(
      claimV4Forfeit({ state, rootState: {}, commit }, { gameId: 'g1', mode: 'manual' }),
    ).rejects.toThrow(/already in progress/i)
    // The mutex check is BEFORE SET_CLAIMING — it must not touch the in-flight map.
    expect(commit).not.toHaveBeenCalled()
  })

  it('with no connected wallet: throws BEFORE setting the in-flight flag (no leaked flag)', async () => {
    const commit = vi.fn()
    const state = { claimingGames: {}, arkAddress: 'ark1xyz' }
    // sdkWallet is null in a fresh import -> requireWalletAndKey throws. It runs
    // BEFORE commit('SET_CLAIMING'), so a no-wallet error never sets the flag — the
    // game is never left stuck "claiming". (Errors AFTER the flag is set are cleared
    // by the finally; that path needs a connected wallet, covered via e2e.)
    await expect(
      claimV4Forfeit({ state, rootState: { wallet: {} }, commit }, { gameId: 'g2', mode: 'auto' }),
    ).rejects.toThrow(/not connected/i)
    expect(commit).not.toHaveBeenCalled()
  })
})
