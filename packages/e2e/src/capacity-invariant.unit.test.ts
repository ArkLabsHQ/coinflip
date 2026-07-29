/**
 * The branch's central invariant: the capacity `/api/tiers` ADVERTISES is
 * exactly the capacity `/play` ENFORCES.
 *
 * Both sides derive it from `freeStakeTotal` and the clamped
 * `getMaxBetFractionBps` — but only by convention. The envelope test in
 * server-api.test.ts asserts types and loose ranges, so it would still pass if
 * `/api/tiers` went back to sizing off the wallet's `available` balance or off
 * the expiry-based `freeHouseVtxos` (the drift the plan correction records
 * happening once already). This pins the NUMBER on both sides.
 *
 * The fixture is deliberately adversarial, so each way of drifting produces a
 * different number and fails:
 *   - `available` (1,000,000) differs from the free stake total (52,350);
 *   - a swept coin (9,000,000) inflates a naive sum over all vtxos;
 *   - a near-expiry coin (12,345) separates `freeStakeTotal` from the REJECTED
 *     `freeHouseVtxos` design — neither set contains the other;
 *   - 52,350 * 2500 / 10,000 = 13,087.5, so floor / round / ceil disagree.
 *
 * Imports the BUILT server (dist) directly, like the sibling unit tests, so the
 * route and the handler share one `vtxo-pool` module — the same coupling
 * production has.
 */
export {}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import express from 'express'
import request from 'supertest'
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
const { schnorr } = require('@noble/curves/secp256k1.js')
const server = require('arkade-coinflip-server')
const emulatorModule = require('arkade-coinflip-server/dist/emulator.js')
const { createPublicRoutes } = require('arkade-coinflip-server/dist/public-routes.js')
const {
  BetExceedsCapacityError, reservations, freeStakeTotal, freeHouseVtxos, spendableTotal,
} = require('arkade-coinflip-server/dist/vtxo-pool.js')

const DUST = 330

const xonlyOf = (b: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(b))
const HOUSE_XONLY = xonlyOf(0x11)
const HOUSE_COMPRESSED = new Uint8Array([2, ...HOUSE_XONLY])
const SERVER_XONLY = xonlyOf(0x22)
const PLAYER_XONLY = xonlyOf(0x33)
const EMULATOR_XONLY = xonlyOf(0x44)
const HOUSE_ADDRESS = new ArkAddress(new Uint8Array(32).fill(0x77), new Uint8Array(32).fill(0x88), 'tark').encode()
const PLAYER_ADDRESS = new ArkAddress(new Uint8Array(32).fill(0x55), new Uint8Array(32).fill(0x66), 'tark').encode()

const FAR_EXPIRY = Date.now() + 24 * 3600_000
/** Inside VTXO_LIFETIME_BUFFER_MS (30 min) — `selectableHouseVtxos` drops this. */
const SOON_EXPIRY = Date.now() + 5 * 60_000

/** A house VTXO whose forfeit leaf embeds HOUSE_XONLY so `choose()` treats it as
 *  co-signable (raw byte-substring match — the leaf is never actually spent). */
function houseCoin(
  txid: string, vout: number, value: number,
  opts: { state?: string; batchExpiry?: number } = {},
) {
  return {
    txid, vout, value,
    virtualStatus: { state: opts.state ?? 'settled', batchExpiry: opts.batchExpiry ?? FAR_EXPIRY },
    status: { confirmed: false },
    createdAt: new Date(Date.now() - 60_000),
    forfeitTapLeafScript: [
      { version: 0xc0, internalKey: xonlyOf(0x99), merklePath: [] as Uint8Array[] },
      new Uint8Array([...HOUSE_XONLY, 0xc0]),
    ],
    tapTree: new Uint8Array([0]),
  }
}

const HEALTHY = houseCoin('aa'.repeat(32), 0, 40_005)
const NEAR_EXPIRY = houseCoin('bb'.repeat(32), 0, 12_345, { batchExpiry: SOON_EXPIRY })
const SWEPT = houseCoin('cc'.repeat(32), 0, 9_000_000, { state: 'swept' })
const VTXOS = [HEALTHY, NEAR_EXPIRY, SWEPT]

const FREE_TOTAL = 52_350            // HEALTHY + NEAR_EXPIRY
const AVAILABLE = 1_000_000          // the wallet balance — deliberately NOT the free total
const CAPACITY = 13_087              // floor(52_350 * 2500 / 10_000); round/ceil give 13_088

function makeDeps(overrides: Record<string, string> = {}) {
  const config: Record<string, string> = {
    tiers: '[330,1000,5000,10000,50000]',
    variable_odds_edge_bps: '300',
    max_bet_fraction_bps: '2500',
    ...overrides,
  }
  return {
    arkInfo: { dust: BigInt(DUST), signerPubkey: hex.encode(SERVER_XONLY), network: 'regtest' },
    wallet: {
      getVtxos: async () => VTXOS,
      getBalance: async () => ({ available: AVAILABLE }),
      getAddress: async () => HOUSE_ADDRESS,
    },
    identity: { compressedPublicKey: async () => HOUSE_COMPRESSED },
    repos: {
      config: { get: async (k: string) => config[k], all: async () => config },
      games: { countPendingForPlayer: async () => 0, save: async () => undefined },
    },
  } as any
}

function mount(deps: any) {
  const app = express()
  app.use(express.json())
  app.use(createPublicRoutes(deps))
  return app
}

/** A plain coin bet (no odds) — houseStake === playerStake, so the tier IS the
 *  house stake the cap is applied to and the boundary needs no inversion. */
function playReq(tier: number) {
  return {
    tier,
    playerPubkey: hex.encode(PLAYER_XONLY),
    playerHash: hex.encode(new Uint8Array(32).fill(0xee)),
    playerPayoutAddress: PLAYER_ADDRESS,
    playerChangeAddress: PLAYER_ADDRESS,
  }
}

async function advertisedCapacity(deps: any): Promise<number> {
  const res = await request(mount(deps)).get('/api/tiers')
  expect(res.status).toBe(200)
  return res.body.capacity
}

describe('advertised capacity === enforced capacity', () => {
  let originalLoadEmulatorConfig: typeof emulatorModule.loadEmulatorConfig

  beforeAll(() => {
    // The cap check runs AFTER handleV4Play's emulator probe, so reaching it
    // needs the probe stubbed (same pattern as play-bet-range.unit.test.ts).
    originalLoadEmulatorConfig = emulatorModule.loadEmulatorConfig
    emulatorModule.loadEmulatorConfig = async () => ({
      url: 'http://emulator.test',
      publicUrl: 'http://emulator.test',
      signerPubkeyHex: hex.encode(EMULATOR_XONLY),
      signerPubkey: EMULATOR_XONLY,
      version: 'test-stub',
    })
  })

  afterAll(() => {
    emulatorModule.loadEmulatorConfig = originalLoadEmulatorConfig
  })

  // An accepted play reserves coins in the process-wide ledger; drop them so the
  // free total is the same for every test regardless of order.
  afterEach(() => {
    for (const r of reservations.snapshot()) reservations.release(r.gameId)
  })

  it('fixture: the free total is neither the wallet balance, the raw vtxo sum, nor the expiry-filtered set', () => {
    expect(freeStakeTotal(VTXOS)).toBe(FREE_TOTAL)
    expect(FREE_TOTAL).not.toBe(AVAILABLE)
    expect(FREE_TOTAL).not.toBe(VTXOS.reduce((s, v) => s + v.value, 0))
    // `freeHouseVtxos` filters on near-expiry, `freeStakeTotal` on coin state —
    // if this stops holding, the fixture no longer distinguishes the two designs.
    expect(freeHouseVtxos(VTXOS).map((v: any) => v.txid)).not.toContain(NEAR_EXPIRY.txid)
  })

  it('/play refuses the first sat ABOVE the capacity /api/tiers published, naming that same number', async () => {
    const deps = makeDeps()
    const advertised = await advertisedCapacity(deps)
    // Pins the source AND the rounding: floor(52_350 * 2500 / 10_000) = 13_087.
    expect(advertised).toBe(CAPACITY)

    let err: unknown
    try {
      await server.handleV4Play(playReq(advertised + 1), deps)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BetExceedsCapacityError)
    // The enforced cap is echoed verbatim — equal to the advertised one, from
    // the same free total. Not a shape check: both numbers are pinned.
    expect((err as Error).message).toContain(`per-bet cap is ${advertised} sat`)
    expect((err as Error).message).toContain(`of ${FREE_TOTAL} sat free`)
  })

  it('/play accepts a bet AT the advertised capacity, and the next publication drops by what it reserved', async () => {
    const deps = makeDeps()
    const advertised = await advertisedCapacity(deps)
    expect(advertised).toBe(CAPACITY)

    // Not merely "not looser" — the enforced cap is not TIGHTER either, or the
    // slider's own maximum would be a bet the server refuses.
    const result = await server.handleV4Play(playReq(advertised), deps)
    expect(result.houseStake).toBe(advertised)

    // Both sides read the SAME reservation ledger: the 40,005-sat coin greedy
    // selection just pinned is gone from the next advertised capacity.
    expect(await advertisedCapacity(deps)).toBe(Math.floor((NEAR_EXPIRY.value * 2500) / 10000))
  })

  it('a malformed max_bet_fraction_bps clamps identically on both sides', async () => {
    // If /api/tiers ever re-parsed the config itself instead of calling the
    // shared clamped reader, it would advertise 99.999% of the free stake while
    // /play kept enforcing the 2500 bps default — drift, one level up.
    const deps = makeDeps({ max_bet_fraction_bps: '99999' })
    const advertised = await advertisedCapacity(deps)
    expect(advertised).toBe(CAPACITY)

    let err: unknown
    try {
      await server.handleV4Play(playReq(advertised + 1), deps)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BetExceedsCapacityError)
    expect((err as Error).message).toContain(`per-bet cap is ${advertised} sat`)
  })
})

/**
 * `/api/tiers` is on the hot path — the play view re-reads it after EVERY flip.
 * It must therefore never make a live wallet read: `wallet.getBalance()` forces
 * a full SDK re-sync, measured at ~4.9s median in production, which burned about
 * as much server time across a session as placing every bet, and overlapped (and
 * slowed) the very `/api/v4/play` it ran alongside.
 *
 * This pins the property as CORRECTNESS rather than performance: the handler is
 * given a wallet whose `getBalance` throws, so any reintroduction of that call
 * fails the suite rather than quietly costing five seconds a flip.
 */
describe('/api/tiers never makes a live balance read', () => {
  /** Deps whose getBalance is a landmine, and whose floor is low enough that
   *  houseReady is true either way (so these assertions are about the SOURCE of
   *  the balance, not about the readiness threshold). */
  function depsWithExplodingBalance() {
    const deps = makeDeps({ min_house_balance: '1000' })
    deps.wallet.getBalance = async () => {
      throw new Error('getBalance() must not be called on the /api/tiers hot path')
    }
    return deps
  }

  it('answers without touching wallet.getBalance()', async () => {
    const res = await request(mount(depsWithExplodingBalance())).get('/api/tiers')
    expect(res.status).toBe(200)
  })

  it('reports the pool-derived spendable total as houseBankroll', async () => {
    const res = await request(mount(depsWithExplodingBalance())).get('/api/tiers')
    // 40,005 + 12,345. NOT the 1,000,000 the wallet balance used to report, and
    // not 9,052,350 — the swept coin is not spendable and must not be counted.
    expect(spendableTotal(VTXOS)).toBe(FREE_TOTAL)
    expect(res.body.houseBankroll).toBe(FREE_TOTAL)
    expect(res.body.houseBankroll).not.toBe(AVAILABLE)
  })

  it('still derives houseReady and maxAvailable from that same total', async () => {
    const res = await request(mount(depsWithExplodingBalance())).get('/api/tiers')
    // Largest tier <= 52,350 out of [330,1000,5000,10000,50000].
    expect(res.body.maxAvailable).toBe(50_000)
    // capacity (13,087) >= dust AND 52,350 >= the 1,000 floor set above.
    expect(res.body.houseReady).toBe(true)
  })

  it('reports NOT ready when the pool total falls under the configured floor', async () => {
    const deps = makeDeps({ min_house_balance: '100000' })
    deps.wallet.getBalance = async () => {
      throw new Error('getBalance() must not be called on the /api/tiers hot path')
    }
    const res = await request(mount(deps)).get('/api/tiers')
    // 52,350 < 100,000. The old live read would have said ready off a balance
    // that did not correspond to actually-spendable coins.
    expect(res.body.houseReady).toBe(false)
  })

  it('advertises a balance and a capacity sampled from ONE snapshot', async () => {
    const res = await request(mount(depsWithExplodingBalance())).get('/api/tiers')
    // Both now come from the same houseVtxoCache read, so they cannot be from
    // two different moments the way a live getBalance() + cached pool could.
    expect(res.body.houseBankroll).toBe(spendableTotal(VTXOS))
    expect(res.body.capacity).toBe(CAPACITY)
  })
})

/**
 * A pinned reservation must be DOWNGRADED once the co-fund has spent those
 * inputs — not merely tolerated by the split guard.
 *
 * Production showed "[house pool] split deferred — 1 outpoint(s) reserved by
 * in-flight games" repeating forever while the admin dashboard listed the only
 * existing coin as FREE. Both were right: the reservation named an input the
 * co-fund had already spent. The split refuses on ANY live outpoint pin, so the
 * pool stayed stuck at one VTXO — one concurrent game.
 *
 * Fixed at the source: v4/cofund.ts re-reserves liability-only the moment
 * cofundArkTxid is set, mirroring what rebuildReservations already does on
 * restart. Loosening the split guard instead would be WRONG — it deliberately
 * fires even for a pin the pool's own free set does not contain, because the
 * SDK's send() selects inputs from ALL spendable coins rather than from that
 * set (reservation-safe-selfspend.unit.test.ts, P0 #53).
 */
describe('a co-funded game holds liability, not pins', () => {
  const { reservations, freeStakeTotal: freeTotal } =
    require('arkade-coinflip-server/dist/vtxo-pool.js')

  afterEach(() => {
    for (const r of reservations.snapshot()) reservations.release(r.gameId)
  })

  it('the post-cofund shape pins no outpoints but keeps the liability', () => {
    // What v4/cofund.ts now installs once the inputs are spent: the bankroll
    // ceiling still holds, and nothing is left to defer the pool split on.
    reservations.reserve('game-after-cofund', [], 50_000)
    expect(reservations.reservedOutpoints().size).toBe(0)
    expect(reservations.totalLiability()).toBe(50_000)
  })

  it('re-reserving a game REPLACES its pins rather than adding to them', () => {
    // The downgrade depends on this: reserve() is a set(), not an append. If it
    // appended, the pins would survive and the wedge would persist.
    const op = `${'dd'.repeat(32)}:0`
    reservations.reserve('g1', [op], 50_000)
    expect(reservations.reservedOutpoints().has(op)).toBe(true)
    reservations.reserve('g1', [], 50_000)
    expect(reservations.reservedOutpoints().has(op)).toBe(false)
    expect(reservations.totalLiability()).toBe(50_000)
  })

  it('a pre-cofund pin still excludes its coin from the free stake total', () => {
    // Asserted so the downgrade cannot be mistaken for weakening pre-cofund
    // protection, which is what actually guards an in-flight co-fund.
    const before = freeTotal(VTXOS)
    reservations.reserve('pre-cofund', [`${HEALTHY.txid}:${HEALTHY.vout}`], 50_000)
    expect(freeTotal(VTXOS)).toBe(before - HEALTHY.value)
  })

  it('and the liability-only downgrade returns that coin to the free total', () => {
    const before = freeTotal(VTXOS)
    reservations.reserve('g', [`${HEALTHY.txid}:${HEALTHY.vout}`], 50_000)
    expect(freeTotal(VTXOS)).toBe(before - HEALTHY.value)
    reservations.reserve('g', [], 50_000)
    expect(freeTotal(VTXOS)).toBe(before)
  })
})
/**
 * A coin arkd has refused to spend must stop being offered.
 *
 * Production failed three games with "VTXO_ALREADY_SPENT (6): 8ef2dcc2…:5
 * already spent" at /api/v4/game/:id/cofund. That coin was one of ten inputs
 * stuck in a settle intent a failed renewal batch could not delete.
 *
 * A cache eviction alone does NOT fix it: refresh() replaces the snapshot
 * wholesale, and arkd keeps LISTING a stranded coin while refusing to spend it —
 * so selection re-picks it and the next player's game dies the same way. Hence a
 * deny-list that survives a refresh.
 */
describe('outpoints arkd rejected as spent are not re-offered', () => {
  const { spentOutpoints, freeStakeTotal: freeTotal, reservations, houseVtxoCache } =
    require('arkade-coinflip-server/dist/vtxo-pool.js')

  beforeEach(() => {
    spentOutpoints.clear()
    for (const r of reservations.snapshot()) reservations.release(r.gameId)
  })
  afterEach(() => spentOutpoints.clear())

  it('a denied coin drops out of the free stake total', () => {
    const before = freeTotal(VTXOS)
    spentOutpoints.mark(`${HEALTHY.txid}:${HEALTHY.vout}`)
    expect(freeTotal(VTXOS)).toBe(before - HEALTHY.value)
  })

  it('survives a snapshot refresh — the whole point', async () => {
    // The coin is still LISTED by getVtxos (arkd advertises it), but must not be
    // spendable-by-us. Re-fetching must not resurrect it.
    spentOutpoints.mark(`${HEALTHY.txid}:${HEALTHY.vout}`)
    const deps = makeDeps()
    houseVtxoCache.invalidate()
    const fresh = await houseVtxoCache.refresh(deps)
    expect(fresh.map((v: any) => v.txid)).toContain(HEALTHY.txid) // still listed
    expect(freeTotal(fresh)).toBe(freeTotal(VTXOS))               // still excluded
  })

  it('the advertised capacity drops to match what /play can deliver', async () => {
    const deps = makeDeps()
    houseVtxoCache.invalidate()
    const before = (await request(mount(deps)).get('/api/tiers')).body.capacity
    expect(before).toBe(CAPACITY)
    spentOutpoints.mark(`${HEALTHY.txid}:${HEALTHY.vout}`)
    houseVtxoCache.invalidate()
    const after = (await request(mount(deps)).get('/api/tiers')).body.capacity
    // Advertising a capacity /play cannot fund is what produces a 400 mid-batch.
    expect(after).toBeLessThan(before)
  })

  it('expires, so a coin freed when arkd clears the intent returns', () => {
    const { SPENT_OUTPOINT_DENY_TTL_MS } =
      require('arkade-coinflip-server/dist/vtxo-pool.js')
    // "Already spent" can be transient — a lingering intent eventually clears.
    // A permanent deny-list would strand the coin until restart.
    expect(SPENT_OUTPOINT_DENY_TTL_MS).toBeGreaterThan(0)
    expect(SPENT_OUTPOINT_DENY_TTL_MS).toBeLessThanOrEqual(3_600_000)
  })

  it('only ever removes coins — it cannot invent spendable value', () => {
    const before = freeTotal(VTXOS)
    for (const v of VTXOS) spentOutpoints.mark(`${v.txid}:${v.vout}`)
    // Worst case is the house declaring itself busy, never a double-spend.
    expect(freeTotal(VTXOS)).toBe(0)
    expect(before).toBeGreaterThan(0)
  })
})

/**
 * `/play` reads a WARM snapshot rather than forcing a live wallet sync.
 *
 * Measured in production: `wallet:getVtxos` was 99.6% of /play — median 2,562ms
 * of a 2,572ms request, with every other phase at 0ms — because it forced a full
 * SDK re-sync per bet. That is what HOUSE_VTXO_CACHE_TTL_MS was designed to
 * avoid; the forced refresh contradicted its own docstring.
 *
 * An earlier attempt at this (reverted) failed because a spent coin could be
 * re-picked. The hole was that the CO-FUND spends house inputs without telling
 * the cache — the split and the renewal settle both invalidate, the co-fund did
 * not — and it is sharper since the post-co-fund reservation downgrade unpins
 * those inputs. These pin the invariants that make the warm read safe.
 */
describe('warm snapshot for /play', () => {
  const {
    houseVtxoCache, HOUSE_VTXO_CACHE_TTL_MS, spentOutpoints, reservations, freeStakeTotal,
  } = require('arkade-coinflip-server/dist/vtxo-pool.js')

  /** The pool-maintenance interval that keeps the snapshot warm. */
  const POOL_TICK_MS = 120_000

  beforeEach(() => {
    houseVtxoCache.invalidate()
    spentOutpoints.clear()
    for (const r of reservations.snapshot()) reservations.release(r.gameId)
  })

  function countingDeps() {
    const deps = makeDeps()
    let calls = 0
    deps.wallet.getVtxos = async () => { calls += 1; return VTXOS }
    return { deps, calls: () => calls }
  }

  it('the TTL outlives the pool tick, or the hot path pays anyway', () => {
    // At exactly the tick interval the TTL expires as the next tick is due, and
    // whichever loses the race hands /play a full re-sync — the 2.5s this
    // removes. A margin means the tick always refreshes first.
    expect(HOUSE_VTXO_CACHE_TTL_MS).toBeGreaterThan(POOL_TICK_MS)
  })

  it('syncs once cold, then serves every later read from the snapshot', async () => {
    const { deps, calls } = countingDeps()
    await houseVtxoCache.get(deps)
    expect(calls()).toBe(1) // cold start still pays once
    await houseVtxoCache.get(deps)
    await houseVtxoCache.get(deps)
    expect(calls()).toBe(1) // the whole point: no per-bet sync
  })

  it('removeOutpoint drops a spent coin from the SAME snapshot a later read sees', async () => {
    // The co-fund's eviction has to be visible to the next selection without a
    // refetch, or the warm read re-offers a coin the co-fund just spent.
    const { deps, calls } = countingDeps()
    await houseVtxoCache.get(deps)
    houseVtxoCache.removeOutpoint(HEALTHY.txid, HEALTHY.vout)
    const after = await houseVtxoCache.get(deps)
    expect(calls()).toBe(1) // served warm, not refetched
    expect(after.map((v: any) => v.txid)).not.toContain(HEALTHY.txid)
  })

  it('and that eviction removes the coin from the free stake total too', async () => {
    const { deps } = countingDeps()
    const before = freeStakeTotal(await houseVtxoCache.get(deps))
    houseVtxoCache.removeOutpoint(HEALTHY.txid, HEALTHY.vout)
    expect(freeStakeTotal(await houseVtxoCache.get(deps))).toBe(before - HEALTHY.value)
  })

  it('an invalidate (split / renewal settle) still forces a fresh sync', async () => {
    const { deps, calls } = countingDeps()
    await houseVtxoCache.get(deps)
    expect(calls()).toBe(1)
    houseVtxoCache.invalidate()
    await houseVtxoCache.get(deps)
    expect(calls()).toBe(2)
  })

  it('a reservation still excludes its coin from a warm read', async () => {
    // Snapshot age is irrelevant to this: selection re-checks isReserved under
    // the mutex, so a coin another game just took can never be double-picked.
    const { deps } = countingDeps()
    const all = await houseVtxoCache.get(deps)
    const before = freeStakeTotal(all)
    reservations.reserve('other-game', [`${HEALTHY.txid}:${HEALTHY.vout}`], 1)
    expect(freeStakeTotal(all)).toBe(before - HEALTHY.value)
  })

  it('the advertised capacity is unchanged by reading warm', async () => {
    const deps = makeDeps()
    const res = await request(mount(deps)).get('/api/tiers')
    expect(res.body.capacity).toBe(CAPACITY)
  })
})
