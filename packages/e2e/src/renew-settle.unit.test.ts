/**
 * Regression unit tests for renewSettle (no regtest). Locks in the fixes from
 * the renewal-settle saga:
 *
 *   1. It must pass EXPLICIT settle params with a single NON-EMPTY self-output.
 *      An earlier "fix" passed settle({ inputs, outputs: [] }) to exclude a
 *      phantom boarding input; empty outputs made arkd reject the intent proof
 *      ("proof does not contain outputs"), so renewal failed every tick and
 *      expiring house VTXOs were never re-minted — surfacing to players as
 *      "House has no free dust-safe VTXO". The params come from
 *      buildReservationSafeSettleParams, which mirrors the SDK's no-arg
 *      gathering (fee + self-output math) but excludes VTXOs reserved for
 *      in-flight games (P0 #53 — the blind settle(undefined) could spend a
 *      coin committed to a live game's co-fund; see
 *      reservation-safe-selfspend.unit.test.ts for the reservation matrix).
 *
 *   2. "No inputs found" (the SDK's empty-eligible-set signal) is a graceful
 *      no-op → returns false, NOT a thrown failure.
 *
 *   3. The phantom-boarding failure (a cached boarding UTXO arkd can't resolve →
 *      TX_NOT_FOUND / "failed to (get|validate) boarding input") is also a
 *      graceful skip → returns false, with an actionable RESYNC_WALLET_ON_BOOT
 *      log, instead of a stack trace every tick. Any OTHER error still rethrows
 *      so the renewal worker logs a real problem.
 *
 * Imports the BUILT server (dist) directly, like the sibling unit tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import { ArkAddress } from '@arkade-os/sdk'
const { renewSettle, buildReservationSafeSettleParams, RENEWAL_EXPIRY_BUFFER_MS } =
  require('arkade-coinflip-server/dist/game-engine.js')
const { reservations, outpointKey } = require('arkade-coinflip-server/dist/vtxo-pool.js')

const HOUSE_ADDRESS = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark').encode()

/** One healthy settled VTXO so the params builder always finds an input.
 *  Expiry +24h keeps it INSIDE the 3-day renewal buffer, so the narrowed
 *  renewal settle still gathers it. */
const FREE_COIN = {
  txid: 'ab'.repeat(32),
  vout: 0,
  value: 40_000,
  virtualStatus: { state: 'settled', batchExpiry: Date.now() + 24 * 3600_000 },
  status: { confirmed: false },
  createdAt: new Date(),
}

function depsWithSettle(settle: (...args: any[]) => Promise<any>) {
  return {
    wallet: {
      dustAmount: 330n,
      arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: -1n }) },
      getBoardingUtxos: async () => [],
      getVtxos: async () => [FREE_COIN],
      getAddress: async () => HOUSE_ADDRESS,
      settle,
    },
  } as any
}

describe('renewSettle (renewal settle path)', () => {
  it('calls settle() with explicit params carrying a single non-empty self-output', async () => {
    const calls: any[][] = []
    const deps = depsWithSettle(async (...args: any[]) => {
      calls.push(args)
      return 'txid-abc'
    })
    const ok = await renewSettle(deps)
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    // Load-bearing: the FIRST arg (settle params) must be an explicit
    // { inputs, outputs } with a NON-EMPTY outputs list. A regression to
    // outputs: [] would make arkd reject with "proof does not contain
    // outputs"; a regression to settle(undefined) would revert to the SDK's
    // reservation-blind gathering (P0 #53). (The 2nd arg is the batch-event
    // handler — see below.)
    const params = calls[0][0]
    expect(params).toBeDefined()
    expect(params.inputs.map((v: any) => `${v.txid}:${v.vout}`)).toEqual([`${FREE_COIN.txid}:0`])
    expect(params.outputs).toHaveLength(1)
    expect(params.outputs[0]).toEqual({ address: HOUSE_ADDRESS, amount: 40_000n })
  })

  it('passes a batch/round event handler as the settle eventCallback', async () => {
    const calls: any[][] = []
    const deps = depsWithSettle(async (...args: any[]) => { calls.push(args); return 'txid' })
    await renewSettle(deps)
    // 2nd arg is the SettlementEvent handler (function) — the per-phase
    // observability layer wired in for every party's settle.
    expect(typeof calls[0][1]).toBe('function')
  })

  it('treats "No inputs found" as a graceful no-op (returns false, does not throw)', async () => {
    const deps = depsWithSettle(async () => { throw new Error('No inputs found') })
    await expect(renewSettle(deps)).resolves.toBe(false)
  })

  it('is case-insensitive on the no-inputs signal', async () => {
    const deps = depsWithSettle(async () => { throw new Error('settle aborted: NO INPUTS FOUND in wallet') })
    await expect(renewSettle(deps)).resolves.toBe(false)
  })

  it('rethrows any other settle failure so the worker logs a real problem', async () => {
    const deps = depsWithSettle(async () => {
      throw new Error('INVALID_INTENT_PROOF (23): proof does not contain outputs')
    })
    await expect(renewSettle(deps)).rejects.toThrow('proof does not contain outputs')
  })

  it('treats the phantom-boarding failure as a graceful skip (returns false, no rethrow)', async () => {
    // A boarding UTXO whose funding tx arkd can't resolve poisons every settle.
    // It looks confirmed locally so it can't be filtered; renewSettle skips the
    // tick (with an actionable RESYNC_WALLET_ON_BOOT log) instead of throwing a
    // stack trace each interval.
    const deps = depsWithSettle(async () => { throw new Error('TX_NOT_FOUND (19): failed to get boarding input tx') })
    await expect(renewSettle(deps)).resolves.toBe(false)
  })

  it('also skips the "failed to validate boarding input" variant', async () => {
    const deps = depsWithSettle(async () => { throw new Error('INVALID_PSBT_INPUT (5): failed to validate boarding input: failed to get tx abc') })
    await expect(renewSettle(deps)).resolves.toBe(false)
  })

  it('still rethrows a non-boarding TX_NOT_FOUND (the phantom-boarding match stays narrow)', async () => {
    const deps = depsWithSettle(async () => { throw new Error('TX_NOT_FOUND (19): some other tx') })
    await expect(renewSettle(deps)).rejects.toThrow('TX_NOT_FOUND')
  })
})

describe('renewSettle narrows to coins that need renewal (SDK renewVtxos semantics)', () => {
  /** Healthy coin far outside the 3-day renewal buffer — must stay untouched. */
  const FAR_COIN = {
    txid: 'cd'.repeat(32),
    vout: 0,
    value: 90_000,
    virtualStatus: { state: 'settled', batchExpiry: Date.now() + RENEWAL_EXPIRY_BUFFER_MS + 7 * 24 * 3600_000 },
    status: { confirmed: false },
    createdAt: new Date(),
  }
  /** Swept-but-spendable coin — the recovery case (arkd rejects a normal
   *  offchain spend with VTXO_RECOVERABLE; only a settle reclaims it). */
  const SWEPT_COIN = {
    txid: 'ef'.repeat(32),
    vout: 1,
    value: 25_000,
    virtualStatus: { state: 'swept', batchExpiry: Date.now() - 3600_000 },
    status: { confirmed: false },
    createdAt: new Date(),
  }

  function depsWithVtxos(vtxos: any[], settleCalls: any[][]) {
    return {
      wallet: {
        dustAmount: 330n,
        arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: -1n }) },
        getBoardingUtxos: async () => [],
        getVtxos: async () => vtxos,
        getAddress: async () => HOUSE_ADDRESS,
        settle: async (...args: any[]) => { settleCalls.push(args); return 'txid' },
      },
    } as any
  }

  it('leaves a healthy far-from-expiry coin untouched (no whole-pool consolidation)', async () => {
    const settleCalls: any[][] = []
    const deps = depsWithVtxos([FAR_COIN, FREE_COIN], settleCalls)
    await expect(renewSettle(deps)).resolves.toBe(true)
    // Pre-narrowing this was the SDK's settle-all mirror: EVERY free coin —
    // including FAR_COIN with weeks of life left — was consolidated into one
    // output on each renewal, collapsing the piece pool.
    expect(settleCalls[0][0].inputs.map((v: any) => v.txid)).toEqual([FREE_COIN.txid])
  })

  it('recovers a swept (recoverable) coin — the swept-fund recovery path', async () => {
    const settleCalls: any[][] = []
    const deps = depsWithVtxos([SWEPT_COIN], settleCalls)
    await expect(renewSettle(deps)).resolves.toBe(true)
    const params = settleCalls[0][0]
    expect(params.inputs.map((v: any) => v.txid)).toEqual([SWEPT_COIN.txid])
    expect(params.outputs[0].amount).toBe(25_000n) // zero-fee mock: full value re-minted
  })

  it('is a graceful no-op when everything is healthy (nothing inside the buffer)', async () => {
    const settleCalls: any[][] = []
    const deps = depsWithVtxos([FAR_COIN], settleCalls)
    await expect(renewSettle(deps)).resolves.toBe(false)
    expect(settleCalls).toHaveLength(0)
  })

  it('admin settle-all semantics are preserved: no filter gathers every free coin', async () => {
    // The admin /api/wallet/settle route calls the builder with no opts — the
    // narrowing must be strictly opt-in.
    const deps = depsWithVtxos([FAR_COIN, FREE_COIN], [])
    const params = await buildReservationSafeSettleParams(deps)
    expect(params.inputs.map((v: any) => v.txid).sort()).toEqual([FAR_COIN.txid, FREE_COIN.txid].sort())
  })
})

describe('renewSettle pins its inputs against a concurrent /play reservation', () => {
  const freeKey = () => outpointKey(FREE_COIN.txid, FREE_COIN.vout)

  it('reserves the chosen inputs for the duration of the settle and releases after', async () => {
    let reservedDuringSettle: boolean | null = null
    const deps = {
      wallet: {
        dustAmount: 330n,
        arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: -1n }) },
        getBoardingUtxos: async () => [],
        getVtxos: async () => [FREE_COIN],
        getAddress: async () => HOUSE_ADDRESS,
        settle: async () => {
          // Mid-settle, /play must see the input as reserved (freeHouseVtxos
          // excludes reserved outpoints) so it can't bake a coin this settle
          // is about to spend into a live game.
          reservedDuringSettle = reservations.isReserved(freeKey())
          return 'txid'
        },
      },
    } as any
    await expect(renewSettle(deps)).resolves.toBe(true)
    expect(reservedDuringSettle).toBe(true)
    expect(reservations.isReserved(freeKey())).toBe(false) // released in finally
  })

  it('releases the pin even when the settle throws', async () => {
    const deps = {
      wallet: {
        dustAmount: 330n,
        arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: -1n }) },
        getBoardingUtxos: async () => [],
        getVtxos: async () => [FREE_COIN],
        getAddress: async () => HOUSE_ADDRESS,
        settle: async () => { throw new Error('BatchFailed: round died') },
      },
    } as any
    await expect(renewSettle(deps)).rejects.toThrow('round died')
    expect(reservations.isReserved(freeKey())).toBe(false)
  })

  it('skips (false, no settle) when a /play reservation lands mid-build', async () => {
    // The builder snapshots the ledger BEFORE fetching VTXOs; simulate a /play
    // racing in during the fetch. The sync pin-check under selectionMutex must
    // catch it and skip — pre-fix the settle would spend the game's coin (the
    // P0 #53 failure through the opposite window).
    const settleCalls: any[] = []
    const deps = {
      wallet: {
        dustAmount: 330n,
        arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: -1n }) },
        getBoardingUtxos: async () => [],
        getVtxos: async () => {
          reservations.reserve('race-game', [freeKey()], 80_000)
          return [FREE_COIN]
        },
        getAddress: async () => HOUSE_ADDRESS,
        settle: async (...args: any[]) => { settleCalls.push(args); return 'txid' },
      },
    } as any
    try {
      await expect(renewSettle(deps)).resolves.toBe(false)
      expect(settleCalls).toHaveLength(0)
    } finally {
      reservations.release('race-game')
    }
  })
})

export {}
