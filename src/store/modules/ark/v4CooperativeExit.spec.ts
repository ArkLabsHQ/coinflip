import { describe, it, expect, vi } from 'vitest'
import { SingleKey, Transaction } from '@arkade-os/sdk'
import { hex, base64 } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { buildCooperativeExitRequest, stepCooperativeExit, type CooperativeExitIo } from './v4CooperativeExit'
import type { StashedV4Forfeit } from './v4ForfeitStash'

const xonlyOf = (b: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(b))
const p2tr = (b: number): Uint8Array => new Uint8Array([0x51, 0x20, ...xonlyOf(b)])
const h = (b: number): string => hex.encode(new Uint8Array(32).fill(b))

async function fixture() {
  const player = SingleKey.fromRandomBytes()
  const playerPub = await player.xOnlyPublicKey()
  const covenant = {
    creatorPubkey: hex.encode(xonlyOf(1)),
    playerPubkey: hex.encode(playerPub),
    serverPubkey: hex.encode(xonlyOf(3)),
    creatorHash: h(0xc0),
    playerHash: h(0xd0),
    finalExpiration: 1_900_000_000,
    cancelDelay: 1_800_000_000,
    exitDelay: 86_528,
    oddsN: 2,
    oddsTarget: 1,
    oddsLo: 0,
    emulatorPubkey: hex.encode(xonlyOf(4)),
    playerPayoutPkScript: hex.encode(p2tr(0xa0)),
    housePayoutPkScript: hex.encode(p2tr(0xb0)),
    playerStake: '50000',
    houseStake: '50000',
  }
  const stash = {
    covenant,
    potOutpoint: { txid: 'cc'.repeat(32), vout: 0, value: 100_000 },
  } as unknown as Pick<StashedV4Forfeit, 'covenant' | 'potOutpoint'>
  return { player, stash }
}

describe('buildCooperativeExitRequest', () => {
  it('builds a player-signed leaf-7 split-back request the house can co-sign', async () => {
    const { player, stash } = await fixture()
    const req = await buildCooperativeExitRequest({
      stash,
      feeSats: 1000n,
      signInput0: (tx) => player.sign(tx, [0]),
    })

    // Echoes the on-chain pot outpoint + the fee.
    expect(req.potOnchain).toEqual(stash.potOutpoint)
    expect(req.feeSats).toBe(1000)

    // The PSBT is a single-input, two-output leaf-7 spend with the exit CSV.
    const tx = Transaction.fromPSBT(base64.decode(req.exitTxPsbt))
    expect(tx.inputsLength).toBe(1)
    expect(tx.outputsLength).toBe(2)
    expect(tx.getInput(0).sequence).toBe(0x4000a9) // exitDelay 86528s → time-based CSV
    // Split-back to both payout scripts, minus half the fee each.
    expect(tx.getOutput(0).amount).toBe(50_000n - 500n)
    expect(tx.getOutput(1).amount).toBe(50_000n - 500n)
    expect(hex.encode(tx.getOutput(0).script!)).toBe(hex.encode(p2tr(0xa0)))
    expect(hex.encode(tx.getOutput(1).script!)).toBe(hex.encode(p2tr(0xb0)))
  })

  it('is deterministic from the stash (same stash → identical unsigned build)', async () => {
    const { stash } = await fixture()
    const noSign = (tx: Transaction) => Promise.resolve(tx)
    const a = await buildCooperativeExitRequest({ stash, feeSats: 1000n, signInput0: noSign })
    const b = await buildCooperativeExitRequest({ stash, feeSats: 1000n, signInput0: noSign })
    expect(a.exitTxPsbt).toBe(b.exitTxPsbt)
  })
})

function mockIo(over: Partial<CooperativeExitIo> = {}): CooperativeExitIo {
  return {
    bumperBalanceSats: vi.fn(async () => 100_000),
    potOnchainStatus: vi.fn(async () => null),
    unrollPot: vi.fn(async () => {}),
    chainTime: vi.fn(async () => 2_000_000_000),
    buildRequest: vi.fn(async () => ({ exitTxPsbt: 'psbt', potOnchain: { txid: 'x', vout: 0, value: 1 }, feeSats: 1 })),
    houseCosign: vi.fn(async () => 'cosigned'),
    broadcast: vi.fn(async () => 'exittxid'),
    ...over,
  }
}
const ARGS = (io: CooperativeExitIo) => ({ exitDelaySeconds: 86_528, minFeeSats: 1000, io })

describe('stepCooperativeExit (state machine, fail-safe)', () => {
  it('needs-fee when the bumper is underfunded — and NEVER unrolls', async () => {
    const io = mockIo({ bumperBalanceSats: vi.fn(async () => 500) })
    const p = await stepCooperativeExit(ARGS(io))
    expect(p.stage).toBe('needs-fee')
    expect(io.unrollPot).not.toHaveBeenCalled()
  })

  it('unrolling: funded + not on-chain → kicks the unroll', async () => {
    const io = mockIo({ potOnchainStatus: vi.fn(async () => null) })
    const p = await stepCooperativeExit(ARGS(io))
    expect(p.stage).toBe('unrolling')
    expect(io.unrollPot).toHaveBeenCalledOnce()
  })

  it('unrolling: on-chain but unconfirmed → waits, does NOT re-unroll or proceed', async () => {
    const io = mockIo({ potOnchainStatus: vi.fn(async () => ({ confirmed: false, confirmedAt: 0 })) })
    const p = await stepCooperativeExit(ARGS(io))
    expect(p.stage).toBe('unrolling')
    expect(io.unrollPot).not.toHaveBeenCalled()
    expect(io.broadcast).not.toHaveBeenCalled()
  })

  it('awaiting-csv: confirmed but CSV not matured → NEVER builds/cosigns/broadcasts', async () => {
    const confirmedAt = 2_000_000_000
    const io = mockIo({
      potOnchainStatus: vi.fn(async () => ({ confirmed: true, confirmedAt })),
      chainTime: vi.fn(async () => confirmedAt + 100), // < confirmedAt + exitDelay
    })
    const p = await stepCooperativeExit(ARGS(io))
    expect(p.stage).toBe('awaiting-csv')
    expect(io.buildRequest).not.toHaveBeenCalled()
    expect(io.houseCosign).not.toHaveBeenCalled()
    expect(io.broadcast).not.toHaveBeenCalled()
  })

  it('done: funded + confirmed + CSV matured → build → house co-sign → broadcast', async () => {
    const confirmedAt = 2_000_000_000
    const io = mockIo({
      potOnchainStatus: vi.fn(async () => ({ confirmed: true, confirmedAt })),
      chainTime: vi.fn(async () => confirmedAt + 86_528 + 10), // matured
    })
    const p = await stepCooperativeExit(ARGS(io))
    expect(p.stage).toBe('done')
    expect(p.exitTxid).toBe('exittxid')
    expect(io.buildRequest).toHaveBeenCalledOnce()
    expect(io.houseCosign).toHaveBeenCalledOnce()
    expect(io.broadcast).toHaveBeenCalledOnce()
  })
})
