import { describe, it, expect, vi, beforeEach } from 'vitest'
import wallet from './wallet'

// Regression test for the v0.5.0 "clear wallet leaves the key behind" bug.
//
// clearWallet awaited two IndexedDB purges (ark/purgeLocalData, ark/purgeStashes)
// BEFORE removing the wallet keys from localStorage. On a real browser one of
// those writes can reject — and purgeStashes had no try/catch — so the awaited
// dispatch threw, the key-removal lines never ran, the privkey/pubkey/mnemonic
// survived the clear, and the app reloaded the OLD wallet's VTXOs/balance on the
// next boot. fake-indexeddb never rejects, so the unit suite missed it.
//
// The fix removes the keys + commits FIRST (synchronous, can't fail), then runs
// the purges best-effort. These tests assert the keys are gone regardless of a
// purge failure.

type Ctx = { commit: ReturnType<typeof vi.fn>; dispatch: ReturnType<typeof vi.fn> }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callClear = (ctx: Ctx): Promise<unknown> => (wallet.actions!.clearWallet as any)(ctx)

const seedWallet = () => {
  localStorage.setItem('wallet_privkey', 'aa'.repeat(32))
  localStorage.setItem('wallet_pubkey', 'bb'.repeat(32))
  localStorage.setItem('wallet_mnemonic', 'field mixed match picnic raw pink gorilla outdoor claim meat luxury crop')
}

describe('clearWallet — the wallet key is always removed', () => {
  beforeEach(seedWallet)

  it('clears all three keys + commits null even when ark/purgeStashes rejects', async () => {
    const commit = vi.fn()
    const dispatch = vi.fn((action: string) =>
      action === 'ark/purgeStashes' ? Promise.reject(new Error('IndexedDB write failed')) : Promise.resolve(),
    )
    await callClear({ commit, dispatch }) // must NOT reject
    expect(localStorage.getItem('wallet_privkey')).toBeNull()
    expect(localStorage.getItem('wallet_pubkey')).toBeNull()
    expect(localStorage.getItem('wallet_mnemonic')).toBeNull()
    expect(commit).toHaveBeenCalledWith('SET_WALLET', { privateKey: null, publicKey: null, mnemonic: null })
  })

  it('clears the keys even when ark/purgeLocalData rejects', async () => {
    const commit = vi.fn()
    const dispatch = vi.fn((action: string) =>
      action === 'ark/purgeLocalData' ? Promise.reject(new Error('boom')) : Promise.resolve(),
    )
    await callClear({ commit, dispatch })
    expect(localStorage.getItem('wallet_privkey')).toBeNull()
    expect(localStorage.getItem('wallet_mnemonic')).toBeNull()
    expect(commit).toHaveBeenCalledWith('SET_WALLET', { privateKey: null, publicKey: null, mnemonic: null })
  })

  it('still runs both purges on the happy path', async () => {
    const commit = vi.fn()
    const dispatch = vi.fn(() => Promise.resolve())
    await callClear({ commit, dispatch })
    expect(dispatch).toHaveBeenCalledWith('ark/purgeLocalData', null, { root: true })
    expect(dispatch).toHaveBeenCalledWith('ark/purgeStashes', null, { root: true })
    expect(localStorage.getItem('wallet_privkey')).toBeNull()
  })
})
