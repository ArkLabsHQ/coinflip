/**
 * Unit tests for the cooperative-exit LIVE edge (makeCooperativeExitIo). The full
 * unroll → leaf-7 spend mechanism is proven on regtest by the v4-cooperative-exit
 * probe; here we pin the two bits of glue LOGIC that aren't pure pass-throughs and
 * would otherwise only be exercised live:
 *   - potOnchainStatus maps getTxStatus → the step machine's null / confirmed contract,
 *   - unrollPot advances one broadcast-wave per tick and STOPS at WAIT/DONE (never
 *     blocking the browser on a confirmation), and swallows a not-yet-indexed session.
 * The SDK statics (OnchainWallet.create / Unroll.Session.create) are spied so no
 * network/wallet is needed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OnchainWallet, Unroll } from '@arkade-os/sdk'
import { makeCooperativeExitIo, type CooperativeExitIoDeps } from './v4CooperativeExitIo'

const POT = { txid: 'ab'.repeat(32), vout: 0, value: 2000 }

/** Build the IO over mock providers; override just what a test needs. */
function makeIo(over: {
  getTxStatus?: () => Promise<unknown>
  getChainTip?: () => Promise<unknown>
  broadcastTransaction?: (hex: string) => Promise<string>
  cosign?: CooperativeExitIoDeps['cosign']
} = {}) {
  const explorer = {
    getTxStatus: vi.fn(over.getTxStatus ?? (async () => ({ confirmed: false }))),
    getChainTip: vi.fn(over.getChainTip ?? (async () => ({ height: 1, time: 100, hash: 'h' }))),
    broadcastTransaction: vi.fn(over.broadcastTransaction ?? (async () => 'txid')),
  }
  const cosign = vi.fn(over.cosign ?? (async () => ({ exitTxPsbt: 'cosigned' })))
  const io = makeCooperativeExitIo({
    identity: {} as CooperativeExitIoDeps['identity'],
    explorer: explorer as unknown as CooperativeExitIoDeps['explorer'],
    indexer: {} as CooperativeExitIoDeps['indexer'],
    network: 'regtest',
    gameId: 'g1',
    stash: { covenant: {} as never, potOutpoint: POT },
    exitFeeSats: 1000,
    cosign,
  })
  return { io, explorer, cosign }
}

afterEach(() => vi.restoreAllMocks())

describe('makeCooperativeExitIo — potOnchainStatus mapping', () => {
  it('returns null while the pot tx is not yet mined (not-found or in mempool)', async () => {
    const { io } = makeIo({ getTxStatus: async () => ({ confirmed: false }) })
    expect(await io.potOnchainStatus()).toBeNull()
  })

  it('returns confirmed + the block time once the pot tx is mined', async () => {
    const { io } = makeIo({ getTxStatus: async () => ({ confirmed: true, blockTime: 1_700_000_000, blockHeight: 42 }) })
    expect(await io.potOnchainStatus()).toEqual({ confirmed: true, confirmedAt: 1_700_000_000 })
  })
})

describe('makeCooperativeExitIo — chainTime / houseCosign', () => {
  it('chainTime returns the chain tip time (MTP basis, not wall clock)', async () => {
    const { io } = makeIo({ getChainTip: async () => ({ height: 9, time: 1_234, hash: 'x' }) })
    expect(await io.chainTime()).toBe(1_234)
  })

  it('houseCosign unwraps the endpoint response to the co-signed PSBT', async () => {
    const { io, cosign } = makeIo({ cosign: async () => ({ exitTxPsbt: 'PSBT64' }) })
    expect(await io.houseCosign({ exitTxPsbt: 'x', potOnchain: POT, feeSats: 1000 })).toBe('PSBT64')
    expect(cosign).toHaveBeenCalledWith('g1', expect.objectContaining({ feeSats: 1000 }))
  })
})

describe('makeCooperativeExitIo — unrollPot stepping', () => {
  /** A fake session whose next() yields the given steps in order. */
  function fakeSession(steps: Array<{ type: Unroll.StepType; do: () => Promise<void> }>) {
    let i = 0
    return { next: vi.fn(async () => steps[i++]) } as unknown as Unroll.Session
  }

  it('broadcasts each UNROLL wave and STOPS at the first WAIT (never blocks)', async () => {
    const done1 = vi.fn(async () => {})
    const done2 = vi.fn(async () => {})
    const waitDo = vi.fn(async () => {})
    const steps = [
      { type: Unroll.StepType.UNROLL, do: done1 },
      { type: Unroll.StepType.UNROLL, do: done2 },
      { type: Unroll.StepType.WAIT, do: waitDo },
    ]
    vi.spyOn(OnchainWallet, 'create').mockResolvedValue({} as OnchainWallet)
    vi.spyOn(Unroll.Session, 'create').mockResolvedValue(fakeSession(steps))

    const { io } = makeIo()
    await io.unrollPot()

    expect(done1).toHaveBeenCalledTimes(1)
    expect(done2).toHaveBeenCalledTimes(1)
    expect(waitDo).not.toHaveBeenCalled() // WAIT is not executed — we return, next tick resumes
  })

  it('stops immediately when the unroll is DONE (no broadcast)', async () => {
    const doneDo = vi.fn(async () => {})
    vi.spyOn(OnchainWallet, 'create').mockResolvedValue({} as OnchainWallet)
    vi.spyOn(Unroll.Session, 'create').mockResolvedValue(fakeSession([{ type: Unroll.StepType.DONE, do: doneDo }]))

    const { io } = makeIo()
    await io.unrollPot()
    expect(doneDo).not.toHaveBeenCalled()
  })

  it('swallows a session-create failure (pot not indexed yet) — retries next tick', async () => {
    vi.spyOn(OnchainWallet, 'create').mockResolvedValue({} as OnchainWallet)
    vi.spyOn(Unroll.Session, 'create').mockRejectedValue(new Error('VTXO not indexed'))

    const { io } = makeIo()
    await expect(io.unrollPot()).resolves.toBeUndefined()
  })
})
