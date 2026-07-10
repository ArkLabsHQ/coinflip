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
import { OnchainWallet, Unroll, SingleKey, Transaction } from '@arkade-os/sdk'
import { hex, base64 } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { makeCooperativeExitIo, type CooperativeExitIoDeps } from './v4CooperativeExitIo'
import { stepCooperativeExit, type CooperativeExitRequest } from './v4CooperativeExit'
import type { StashedV4Forfeit } from './v4ForfeitStash'

const xonlyOf = (b: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(b))
const p2tr = (b: number): Uint8Array => new Uint8Array([0x51, 0x20, ...xonlyOf(b)])
const h = (b: number): string => hex.encode(new Uint8Array(32).fill(b))

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
  it('returns null while the pot tx is in the mempool (getTxStatus resolves {confirmed:false})', async () => {
    const { io } = makeIo({ getTxStatus: async () => ({ confirmed: false }) })
    expect(await io.potOnchainStatus()).toBeNull()
  })

  it('returns null (NOT throws) when the pot tx is not broadcast yet — EsploraProvider 404s', async () => {
    // The real EsploraProvider.getTxStatus THROWS a 404 for a txid esplora has never
    // seen (the pot tx before the unroll broadcasts it). potOnchainStatus must swallow
    // that as null so the step machine drives unrollPot — a throw here would stall the
    // whole flow (the unroll would never start).
    const { io } = makeIo({ getTxStatus: async () => { throw new Error('Not Found') } })
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

describe('makeCooperativeExitIo — end-to-end composition with stepCooperativeExit', () => {
  // The real IO factory driving the real state machine over faithful mock providers:
  // proves the multi-tick flow COMPOSES through every stage, exercising the exact
  // IO↔state-machine seam that Finding 1 (getTxStatus throwing) lived in. Grounded in
  // the CORRECTED SDK contract (getTxStatus throws a 404 while the pot is unbroadcast).
  it('drives needs-fee → unrolling → awaiting-csv → done, ending in a broadcast exit', async () => {
    const STAKE = 50_000
    const EXIT_DELAY = 86_528
    const BLOCK_TIME = 5_000
    const player = SingleKey.fromRandomBytes()
    const house = SingleKey.fromRandomBytes()
    const housePub = await house.xOnlyPublicKey()
    const playerPub = await player.xOnlyPublicKey()

    // creatorPubkey = the house key, so houseCosign can sign leaf 7's creator slot and
    // the split-back finalizes (2-of-2 [player, creator]).
    const covenant = {
      creatorPubkey: hex.encode(housePub), playerPubkey: hex.encode(playerPub), serverPubkey: hex.encode(xonlyOf(3)),
      creatorHash: h(0xc0), playerHash: h(0xd0),
      finalExpiration: 1_900_000_000, cancelDelay: 1_800_000_000, exitDelay: EXIT_DELAY,
      oddsN: 2, oddsTarget: 1, oddsLo: 0, emulatorPubkey: hex.encode(xonlyOf(4)),
      playerPayoutPkScript: hex.encode(p2tr(0xa0)), housePayoutPkScript: hex.encode(p2tr(0xb0)),
      playerStake: String(STAKE), houseStake: String(STAKE),
    }
    const stash = {
      covenant, potOutpoint: { txid: 'cc'.repeat(32), vout: 0, value: 2 * STAKE },
    } as unknown as Pick<StashedV4Forfeit, 'covenant' | 'potOutpoint'>

    // Mutable mock chain state, advanced by the test between ticks.
    const chain = { bumperBalance: 0, potConfirmed: false, now: 1_000 }

    const explorer = {
      async getTxStatus() {
        // Faithful to the real EsploraProvider: 404-throw while the pot is unbroadcast.
        if (!chain.potConfirmed) throw new Error('Not Found')
        return { confirmed: true, blockTime: BLOCK_TIME, blockHeight: 1 }
      },
      async getChainTip() { return { height: 1, time: chain.now, hash: 'h' } },
      broadcastTransaction: vi.fn(async () => 'EXITTXID'),
    }
    vi.spyOn(OnchainWallet, 'create').mockResolvedValue(
      { getBalance: async () => chain.bumperBalance } as unknown as OnchainWallet,
    )
    const unrollDo = vi.fn(async () => {})
    vi.spyOn(Unroll.Session, 'create').mockImplementation(async () => {
      let i = 0 // one UNROLL wave then WAIT, per session
      return { next: async () => (i++ === 0
        ? { type: Unroll.StepType.UNROLL, do: unrollDo }
        : { type: Unroll.StepType.WAIT, do: vi.fn() }) } as unknown as Unroll.Session
    })
    // House co-sign = sign input 0 of the player-signed exit with the house key.
    const houseCosign = vi.fn(async (_g: string, req: CooperativeExitRequest) => {
      const signed = await house.sign(Transaction.fromPSBT(base64.decode(req.exitTxPsbt)), [0])
      return { exitTxPsbt: base64.encode(signed.toPSBT()) }
    })

    const io = makeCooperativeExitIo({
      identity: player,
      explorer: explorer as unknown as CooperativeExitIoDeps['explorer'],
      indexer: {} as CooperativeExitIoDeps['indexer'],
      network: 'regtest', gameId: 'g1', stash, exitFeeSats: 1_000, cosign: houseCosign,
    })
    const tick = () => stepCooperativeExit({ exitDelaySeconds: EXIT_DELAY, minFeeSats: 20_000, io })

    // 1. No bumper funds → needs-fee.
    expect((await tick()).stage).toBe('needs-fee')

    // 2. Fund the bumper; pot still unbroadcast (getTxStatus 404s → null) → unroll runs.
    chain.bumperBalance = 20_000
    expect((await tick()).stage).toBe('unrolling')
    expect(unrollDo).toHaveBeenCalled() // the UNROLL wave actually broadcast

    // 3. Pot confirms on-chain but the exit CSV hasn't matured → awaiting-csv.
    chain.potConfirmed = true
    chain.now = BLOCK_TIME + 10
    expect((await tick()).stage).toBe('awaiting-csv')

    // 4. Chain time passes the exit CSV → build + house co-sign + broadcast → done.
    chain.now = BLOCK_TIME + EXIT_DELAY + 10
    const final = await tick()
    expect(final.stage).toBe('done')
    expect(final.exitTxid).toBe('EXITTXID')
    expect(houseCosign).toHaveBeenCalledOnce()
    expect(explorer.broadcastTransaction).toHaveBeenCalledOnce()
  })
})
