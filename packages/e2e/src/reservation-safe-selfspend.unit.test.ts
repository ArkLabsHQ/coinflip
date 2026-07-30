/**
 * P0 #53 reproducers: reservation-blind house self-spends. The house reserves
 * specific VTXOs for in-flight co-fund games (vtxo-pool `reservations`), but
 * several house self-spend paths ignored the ledger and could spend a coin
 * already committed to a LIVE game — arkd then rejects the game's co-fund with
 * VTXO_ALREADY_SPENT, breaking the player's game:
 *
 *   - renewSettle / admin POST /api/wallet/settle: `settle(undefined)` lets the
 *     SDK gather ALL eligible VTXOs, including reserved ones.
 *   - ensureHouseVtxoPool (split) / admin POST /api/wallet/fragment:
 *     `wallet.send(...)` sizes from free coins but the SDK picks the actual
 *     inputs from ALL coins.
 *
 * Fixed behavior asserted here:
 *   - settle paths pass EXPLICIT SettleParams whose inputs exclude every
 *     reserved outpoint (and never an empty outputs list — arkd rejects that).
 *   - the pool split mints each piece with sendBitcoin({selectedVtxos}) over
 *     inputs drawn from the UNRESERVED set and pinned under the /play selection
 *     mutex, then sends outside it. It no longer defers while a reservation is
 *     live (that declined almost every attempt under autoplay, and holding the
 *     mutex across the send cost a MEASURED 9,389ms /play stall) — the input
 *     pinning enforces the same invariant directly. Liability-only
 *     reservations, as before, don't block.
 *   - admin POST /api/wallet/send mirrors the SDK's own `_sendImpl` selection
 *     (same candidate set: getVtxos({withRecoverable:false}) minus
 *     pendingRecoveryOutpoints(); same selector: selectVirtualCoins to
 *     max(amount, dust)) with reserved outpoints removed, and passes the picks
 *     as sendBitcoin({selectedVtxos}). Every coin it hands to arkd is one the
 *     SDK's blind path could have picked itself — minus the reserved ones —
 *     so arkd accepts them identically. Free-set shortfall is a clean 400
 *     (no spend); force:true keeps the blind operator hatch.
 *
 * Imports the BUILT server (dist) directly, like the sibling unit tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import express from 'express'
import request from 'supertest'
import { ArkAddress } from '@arkade-os/sdk'
const { renewSettle } = require('arkade-coinflip-server/dist/game-engine.js')
const { ensureHouseVtxoPool, reservations, houseVtxoCache } = require('arkade-coinflip-server/dist/vtxo-pool.js')
const { createAdminRoutes } = require('arkade-coinflip-server/dist/admin/routes.js')

const FUTURE_EXPIRY = Date.now() + 24 * 3600_000
/** A structurally valid Ark address (the settle builder decodes it for the output script). */
const HOUSE_ADDRESS = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark').encode()

/** A healthy settled house VTXO, far from expiry. */
const coin = (txid: string, vout: number, value: number) => ({
  txid,
  vout,
  value,
  virtualStatus: { state: 'settled', batchExpiry: FUTURE_EXPIRY },
  status: { confirmed: false },
  createdAt: new Date(Date.now() - 60_000),
})
const outpoints = (coins: Array<{ txid: string; vout: number }>) => coins.map((c) => `${c.txid}:${c.vout}`)

/** Wallet mock for the settle paths (zero intent fees → net amounts are exact). */
function mockSettleWallet(vtxos: any[], settleCalls: any[][]) {
  return {
    dustAmount: 330n,
    arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: -1n }) },
    getBoardingUtxos: async () => [],
    getVtxos: async () => vtxos,
    getAddress: async () => HOUSE_ADDRESS,
    getBalance: async () => ({ available: vtxos.reduce((s: number, v: any) => s + v.value, 0), boarding: { total: 0 } }),
    settle: async (...args: any[]) => {
      settleCalls.push(args)
      return 'txid-settle'
    },
  }
}

describe('P0 #53 — renewSettle must not gather reserved house VTXOs', () => {
  afterEach(() => {
    reservations.release('p0-53-renew')
  })

  it('settles with EXPLICIT params that exclude reserved outpoints (not blind settle(undefined))', async () => {
    const reservedCoin = coin('aa'.repeat(32), 0, 50_000)
    const freeCoin = coin('bb'.repeat(32), 1, 40_000)
    reservations.reserve('p0-53-renew', [`${reservedCoin.txid}:0`], 100_000)
    const settleCalls: any[][] = []
    const deps = { wallet: mockSettleWallet([reservedCoin, freeCoin], settleCalls) } as any

    const ok = await renewSettle(deps)

    expect(ok).toBe(true)
    expect(settleCalls).toHaveLength(1)
    const params = settleCalls[0][0]
    // Pre-fix this was undefined — the SDK's no-arg settle() gathers ALL
    // eligible VTXOs, including the one reserved for a live game.
    expect(params).toBeDefined()
    expect(outpoints(params.inputs)).toEqual([`${freeCoin.txid}:1`])
    // Never an empty outputs list (arkd: "proof does not contain outputs");
    // single self-output for the net amount, like the SDK's own gathering.
    expect(params.outputs).toHaveLength(1)
    expect(params.outputs[0].address).toBe(HOUSE_ADDRESS)
    expect(params.outputs[0].amount).toBe(40_000n) // zero-fee mock: the free coin's value, no reserved value
    // The per-phase settlement event handler is still wired in.
    expect(typeof settleCalls[0][1]).toBe('function')
  })

  it('is a graceful no-op (no settle round) when every eligible VTXO is reserved', async () => {
    const reservedCoin = coin('cc'.repeat(32), 2, 60_000)
    reservations.reserve('p0-53-renew', [`${reservedCoin.txid}:2`], 120_000)
    const settleCalls: any[][] = []
    const deps = { wallet: mockSettleWallet([reservedCoin], settleCalls) } as any

    await expect(renewSettle(deps)).resolves.toBe(false)
    expect(settleCalls).toHaveLength(0)
  })
})

/**
 * The split's P0 #53 guard changed MECHANISM, so these assertions changed with
 * it — and got stricter.
 *
 * It used to enforce "never spend a reserved coin" by REFUSING to run whenever
 * any outpoint was reserved, because `wallet.send(...)` picks its inputs
 * internally from all spendable coins. That was safe but nearly always
 * declined under autoplay, and it held `selectionMutex` across the network
 * send (a MEASURED 9,389ms /play stall).
 *
 * It now enforces the same invariant DIRECTLY: every piece is minted with
 * `sendBitcoin({selectedVtxos})` over inputs we choose from the unreserved set
 * and pin under the mutex. So instead of asserting "did not run", these assert
 * the stronger and more useful property — it DOES run, and the inputs it
 * actually handed the SDK contain no reserved outpoint.
 */
describe('P0 #53 — ensureHouseVtxoPool never hands a reserved outpoint to the SDK', () => {
  afterEach(() => {
    reservations.release('p0-53-split')
    reservations.release('__house_pool_split__')
    houseVtxoCache.invalidate()
  })

  /** Records every `selectedVtxos` set the splitter submits. */
  function splitDeps(vtxos: any[], sentInputs: any[][], sendCalls: any[][] = []) {
    return {
      arkInfo: { dust: 330n },
      repos: { config: { get: async () => '[330,1000,5000,10000,50000]' } },
      wallet: {
        getVtxos: async () => vtxos,
        getAddress: async () => HOUSE_ADDRESS,
        sendBitcoin: async (params: any) => {
          sentInputs.push(params.selectedVtxos)
          return 'txid-split'
        },
        // Must stay unused — it is the reservation-blind path.
        send: async (...recipients: any[]) => {
          sendCalls.push(recipients)
          return 'txid-blind'
        },
      },
    } as any
  }

  it('splits WHILE a reservation is live, but never over the reserved coin', async () => {
    houseVtxoCache.invalidate()
    const reserved = coin('dd'.repeat(32), 0, 200_000)
    const free = coin('ee'.repeat(32), 0, 200_000)
    reservations.reserve('p0-53-split', [`${reserved.txid}:0`], 50_000)
    const sentInputs: any[][] = []
    const sendCalls: any[][] = []
    const deps = splitDeps([reserved, free], sentInputs, sendCalls)

    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 1 })

    // The whole point of the change: a live reservation no longer blocks it.
    expect(r.created).toBe(1)
    expect(sentInputs).toHaveLength(1)
    // The invariant: not one submitted input is the reserved outpoint.
    const submitted = sentInputs.flat().map((v: any) => `${v.txid}:${v.vout}`)
    expect(submitted).not.toContain(`${reserved.txid}:0`)
    expect(submitted).toEqual([`${free.txid}:0`])
    // And the reservation-blind path was never touched.
    expect(sendCalls).toHaveLength(0)
  })

  it('declines rather than spending the reserved coin when it is the ONLY one', async () => {
    houseVtxoCache.invalidate()
    const onlyCoin = coin('dd'.repeat(32), 0, 200_000)
    reservations.reserve('p0-53-split', [`${onlyCoin.txid}:0`], 50_000)
    const sentInputs: any[][] = []
    const sendCalls: any[][] = []
    const deps = splitDeps([onlyCoin], sentInputs, sendCalls)

    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 1 })

    expect(r.created).toBe(0)
    expect(sentInputs).toHaveLength(0)
    expect(sendCalls).toHaveLength(0)
    // ...and it says why, instead of a bare 0.
    expect(r.reason).toBeTruthy()
  })

  it('pins its own inputs so a concurrent /play cannot select them', async () => {
    houseVtxoCache.invalidate()
    const free = coin('ee'.repeat(32), 0, 200_000)
    const seenDuringSend: boolean[] = []
    const deps = splitDeps([free], [], [])
    deps.wallet.sendBitcoin = async () => {
      // While the send is in flight the coin must be reserved — that is what
      // makes it safe to run OUTSIDE the selection mutex.
      seenDuringSend.push(reservations.isReserved(`${free.txid}:0`))
      return 'txid-split'
    }

    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 1 })

    expect(r.created).toBe(1)
    expect(seenDuringSend).toEqual([true])
    // ...and the pin is dropped afterwards, so the coin returns to the pool.
    expect(reservations.isReserved(`${free.txid}:0`)).toBe(false)
  })

  it('releases its pin even when the send fails', async () => {
    houseVtxoCache.invalidate()
    const free = coin('ee'.repeat(32), 0, 200_000)
    const deps = splitDeps([free], [], [])
    deps.wallet.sendBitcoin = async () => { throw new Error('arkd said no') }

    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 1 })

    expect(r.created).toBe(0)
    expect(r.reason).toMatch(/arkd said no/)
    // A leaked pin would permanently shrink the pool.
    expect(reservations.isReserved(`${free.txid}:0`)).toBe(false)
  })

  it('liability-only reservations (no pinned outpoints) do not block the split', async () => {
    houseVtxoCache.invalidate()
    // Post-cofund v4 games reserve liability with NO outpoints — those can run
    // for many minutes and must not starve pool maintenance.
    reservations.reserve('p0-53-split', [], 50_000)
    const sentInputs: any[][] = []
    const deps = splitDeps([coin('99'.repeat(32), 0, 200_000)], sentInputs)

    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 1 })

    expect(r.created).toBe(1)
    expect(sentInputs).toHaveLength(1)
  })

  /**
   * The background tick and an admin POST /api/wallet/fragment can fire at the
   * same time. `reservations.reserve()` REPLACES a holder's pins rather than
   * merging them, so two runs sharing one reservation id would have the second
   * wipe the first's pin WHILE ITS SEND WAS IN FLIGHT — handing the coin back
   * to /play mid-spend, which is the P0 #53 hazard this design closes.
   */
  it('a concurrent split is refused, and cannot unpin the running one', async () => {
    houseVtxoCache.invalidate()
    const free = coin('ee'.repeat(32), 0, 400_000)
    const deps = splitDeps([free], [], [])

    let releaseSend: (() => void) | null = null
    const sendStarted = new Promise<void>((startResolve) => {
      deps.wallet.sendBitcoin = async () => {
        startResolve()
        await new Promise<void>((r) => { releaseSend = r })
        return 'txid-split'
      }
    })

    const first = ensureHouseVtxoPool(deps, { piecesPerRun: 1 })
    await sendStarted // the first run is now mid-send, holding its pin

    // Second caller arrives while the first is in flight.
    const second = await ensureHouseVtxoPool(deps, { piecesPerRun: 1 })
    expect(second.created).toBe(0)
    expect(second.reason).toMatch(/already running/)
    // The decisive assertion: the running split's pin is UNTOUCHED.
    expect(reservations.isReserved(`${free.txid}:0`)).toBe(true)

    ;(releaseSend as unknown as () => void)()
    const r = await first
    expect(r.created).toBe(1)
    // Both runs are done, so nothing stays pinned.
    expect(reservations.isReserved(`${free.txid}:0`)).toBe(false)
  })

  /**
   * Same-tick arrival: both calls are launched with NO await between them, so
   * neither has had a chance to set the flag when the other starts.
   *
   * Verified honestly — this passes against BOTH the current ordering and one
   * that checks the flag after an await, because the check-and-set pair is
   * synchronous and therefore atomic on a single-threaded event loop. It pins
   * the observable behaviour (exactly one run, one send, no overlap), not the
   * placement of the check. The ordering that WOULD break the guard is an
   * `await` between the check and the assignment, which no test can catch
   * without introducing one.
   */
  it('holds when both callers arrive in the same tick', async () => {
    houseVtxoCache.invalidate()
    const free = coin('ee'.repeat(32), 0, 400_000)
    const sentInputs: any[][] = []
    const deps = splitDeps([free], sentInputs, [])
    let concurrentSends = 0
    let maxConcurrent = 0
    deps.wallet.sendBitcoin = async (params: any) => {
      concurrentSends++
      maxConcurrent = Math.max(maxConcurrent, concurrentSends)
      sentInputs.push(params.selectedVtxos)
      await new Promise((r) => setTimeout(r, 20))
      concurrentSends--
      return 'txid-split'
    }

    // No await between them — both enter while the flag is still false.
    const [a, b] = await Promise.all([
      ensureHouseVtxoPool(deps, { piecesPerRun: 1 }),
      ensureHouseVtxoPool(deps, { piecesPerRun: 1 }),
    ])

    // Exactly one ran; the other was refused.
    const refused = [a, b].filter((r: any) => /already running/.test(r.reason))
    expect(refused).toHaveLength(1)
    expect([a, b].filter((r: any) => r.created === 1)).toHaveLength(1)
    // The decisive assertion: two sends never overlapped on the same coin.
    expect(maxConcurrent).toBe(1)
    expect(sentInputs).toHaveLength(1)
  })

  /**
   * Never spend a coin to recreate a coin of the same size. That is pure churn
   * costing a tx, and it would drive `sendBitcoin` down a zero-change path
   * whose behaviour is unverified — so the candidate must clear
   * `amount + dust`, not merely equal `amount`.
   */
  it('refuses to churn: will not spend an exactly-piece-sized coin', async () => {
    houseVtxoCache.invalidate()
    // Two 5,000-sat coins: the ladder's smallest rung is 5,000 (maxTier/10),
    // and a 5,000 bankroll wants more 5,000s than it has — but neither coin can
    // fund one while leaving dust-safe change.
    const sentInputs: any[][] = []
    const deps = splitDeps(
      [coin('11'.repeat(32), 0, 5_000), coin('22'.repeat(32), 0, 5_000)],
      sentInputs,
    )

    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 2 })

    expect(r.created).toBe(0)
    expect(sentInputs).toHaveLength(0) // no churn tx
    expect(r.reason).toBeTruthy()
  })

  it('does spend a coin that clears amount + dust', async () => {
    houseVtxoCache.invalidate()
    const sentInputs: any[][] = []
    // 5,000 + 330 dust + headroom — comfortably fundable.
    const big = coin('33'.repeat(32), 0, 80_000)
    const deps = splitDeps([big], sentInputs)

    const r = await ensureHouseVtxoPool(deps, { piecesPerRun: 1 })

    expect(r.created).toBe(1)
    expect(sentInputs[0].map((v: any) => v.txid)).toEqual([big.txid])
  })

  it('releases the in-flight guard even when a run throws', async () => {
    houseVtxoCache.invalidate()
    const free = coin('ee'.repeat(32), 0, 200_000)
    const deps = splitDeps([free], [], [])
    // Throw from getAddress — before the per-piece try/finally exists.
    deps.wallet.getAddress = async () => { throw new Error('address lookup died') }

    await expect(ensureHouseVtxoPool(deps, { piecesPerRun: 1 })).rejects.toThrow(/address lookup died/)

    // A stuck guard would wedge the splitter until restart — the shape of the
    // 1M-sat loss (a tick that left `renewing = true` forever).
    const deps2 = splitDeps([free], [], [])
    const r = await ensureHouseVtxoPool(deps2, { piecesPerRun: 1 })
    expect(r.reason).not.toMatch(/already running/)
  })

  /**
   * `targetCount` is a FLOOR, not a log label.
   *
   * This is the regression the v4 e2e caught and every unit test missed. That
   * suite calls `ensureHouseVtxoPool(deps, { targetCount: 8, pieceSize: BET*5 })`
   * ONCE and needs the pool filled, because v4 spends a WHOLE house VTXO per
   * game. Capping every run at SPLIT_PIECES_PER_RUN (4) left 5 free coins, the
   * later games drained it, and /play failed with
   * "per-bet cap is 0 sat (25% of 0 sat free)".
   *
   * Below the floor a run must catch up; at or above it, it paces.
   */
  it('one call reaches the floor when below it, rather than pacing', async () => {
    houseVtxoCache.invalidate()
    // Mirrors the e2e: one big settled coin, ask for a floor of 8.
    const sentInputs: any[][] = []
    let pool = [coin('ee'.repeat(32), 0, 500_000)]
    const deps = splitDeps(pool, sentInputs)
    deps.wallet.getVtxos = async () => pool
    // Model the chain the real splitter walks: spend the input, mint the piece,
    // return the change — exactly what the e2e log showed (495000 → 490000 → …).
    deps.wallet.sendBitcoin = async (params: any) => {
      sentInputs.push(params.selectedVtxos)
      const spent = params.selectedVtxos[0]
      const change = spent.value - params.amount
      pool = pool.filter((c: any) => !(c.txid === spent.txid && c.vout === spent.vout))
      pool.push(coin(spent.txid.slice(0, 62) + 'ff', 0, params.amount))
      if (change > 0) pool.push(coin(spent.txid.slice(0, 62) + 'ee', 1, change))
      return 'txid-split'
    }

    const r = await ensureHouseVtxoPool(deps, { targetCount: 8, pieceSize: 5_000 })

    // Pre-fix this minted 4 and the pool sat at 5 free, which starved the v4
    // e2e's later games. It now runs to the bound (16) because a 500,000
    // bankroll at a 5,000 rung wants far more than that.
    expect(r.created).toBe(16)
    const free = pool.filter((c: any) => c.value > 0).length
    expect(free).toBeGreaterThanOrEqual(16)
  })

  /**
   * The ladder — not a piece count — is what stops a run. An earlier version
   * added a second, count-based rule ("stop once the pool reaches
   * POOL_TARGET_COUNT") which starved the v4 e2e's later games. `planSplit`
   * already returns an empty plan once every rung's target is met, so a
   * satisfied pool costs exactly one snapshot read and mints nothing.
   */
  it('stops when the ladder is satisfied, well before the run bound', async () => {
    houseVtxoCache.invalidate()
    const sentInputs: any[][] = []
    // One 5,000-rung ladder at 100% weight over a 12,000 bankroll wants
    // floor(12000/5000) = 2 pieces, and one already exists — so exactly one
    // more is minted even though the run bound is 16.
    let pool = [coin('11'.repeat(32), 0, 5_000), coin('ee'.repeat(32), 0, 7_000)]
    const deps = splitDeps(pool, sentInputs)
    deps.wallet.getVtxos = async () => pool
    deps.wallet.sendBitcoin = async (params: any) => {
      sentInputs.push(params.selectedVtxos)
      const spent = params.selectedVtxos[0]
      const change = spent.value - params.amount
      pool = pool.filter((c: any) => !(c.txid === spent.txid && c.vout === spent.vout))
      pool.push(coin(spent.txid.slice(0, 62) + 'ff', 0, params.amount))
      if (change > 0) pool.push(coin(spent.txid.slice(0, 62) + 'ee', 1, change))
      return 'txid-split'
    }

    const r = await ensureHouseVtxoPool(deps, { pieceSize: 5_000 })

    expect(r.created).toBeLessThan(16)          // not run to the bound
    expect(r.reason).toBeTruthy()
  })

  it('fails loudly if the SDK ever drops selectedVtxos support', () => {
    const { assertSelectedVtxosSupported } =
      require('arkade-coinflip-server/dist/vtxo-pool.js')
    // Present → fine.
    expect(() => assertSelectedVtxosSupported({ sendBitcoin: () => undefined })).not.toThrow()
    // Gone → must throw, NOT silently fall back to the blind `send` path.
    expect(() => assertSelectedVtxosSupported({})).toThrow(/P0 #53|selectedVtxos/)
    expect(() => assertSelectedVtxosSupported(null)).toThrow(/selectedVtxos/)
  })
})

describe('P0 #53 — admin POST /api/wallet/settle excludes reserved outpoints', () => {
  afterEach(() => {
    reservations.release('p0-53-admin')
  })

  it('passes explicit reservation-filtered params to wallet.settle', async () => {
    const reservedCoin = coin('11'.repeat(32), 0, 70_000)
    const freeCoin = coin('22'.repeat(32), 3, 30_000)
    reservations.reserve('p0-53-admin', [`${reservedCoin.txid}:0`], 140_000)
    const settleCalls: any[][] = []
    const deps = { wallet: mockSettleWallet([reservedCoin, freeCoin], settleCalls) } as any
    const app = express()
    app.use(express.json())
    app.use(createAdminRoutes(deps))

    const res = await request(app).post('/api/wallet/settle').send({})

    expect(res.status).toBe(200)
    expect(settleCalls).toHaveLength(1)
    const params = settleCalls[0][0]
    // Pre-fix: settle(undefined) — same reservation-blind gathering as renewal.
    expect(params).toBeDefined()
    expect(outpoints(params.inputs)).toEqual([`${freeCoin.txid}:3`])
    expect(params.outputs).toHaveLength(1)
  })
})

describe('P0 #53 — admin POST /api/wallet/send spends only un-reserved coins', () => {
  afterEach(() => {
    reservations.release('p0-53-send')
  })

  /**
   * Wallet mock for the send path. The handler mirrors `_sendImpl`'s candidate
   * set (getVtxos({withRecoverable:false}) minus pendingRecoveryOutpoints())
   * before removing reserved outpoints, so the mock exposes both reads plus the
   * dust floor the selection target uses.
   */
  function sendApp(vtxos: any[], sendCalls: any[], pendingRecovery: string[] = []) {
    const deps = {
      wallet: {
        dustAmount: 330n,
        getBalance: async () => ({ available: vtxos.reduce((s: number, v: any) => s + v.value, 0) }),
        getVtxos: async () => vtxos,
        pendingRecoveryOutpoints: async () => new Set(pendingRecovery),
        sendBitcoin: async (params: any) => {
          sendCalls.push(params)
          return 'txid-send'
        },
      },
    } as any
    const app = express()
    app.use(express.json())
    app.use(createAdminRoutes(deps))
    return app
  }

  it('selects the FREE coin as an explicit selectedVtxos, never the reserved one', async () => {
    const reservedCoin = coin('33'.repeat(32), 0, 60_000)
    const freeCoin = coin('44'.repeat(32), 1, 40_000)
    // Small liability: the coarse liability guard passes — only the outpoint
    // exclusion can keep the reserved coin out of the spend.
    reservations.reserve('p0-53-send', [`${reservedCoin.txid}:0`], 2_000)
    const sendCalls: any[] = []
    const app = sendApp([reservedCoin, freeCoin], sendCalls)

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000 })

    expect(res.status).toBe(200)
    expect(res.body.txid).toBe('txid-send')
    expect(sendCalls).toHaveLength(1)
    // Pre-fix this was a blind sendBitcoin({address, amount}) — the SDK's
    // internal selection could pick the reserved coin (the P0 residual).
    expect(sendCalls[0].selectedVtxos).toBeDefined()
    expect(outpoints(sendCalls[0].selectedVtxos)).toEqual([`${freeCoin.txid}:1`])
    expect(sendCalls[0].address).toBe(HOUSE_ADDRESS)
    expect(sendCalls[0].amount).toBe(1000)
  })

  it('keeps the SDK selector order (near-expiry first) on the free set', async () => {
    const later = coin('55'.repeat(32), 0, 50_000)
    const sooner = { ...coin('66'.repeat(32), 1, 40_000), virtualStatus: { state: 'settled', batchExpiry: FUTURE_EXPIRY - 3600_000 } }
    const sendCalls: any[] = []
    const app = sendApp([later, sooner], sendCalls)

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000 })

    expect(res.status).toBe(200)
    // selectVirtualCoins sorts batchExpiry ascending — the sooner-expiring coin
    // wins even though the later one is larger (same pick _sendImpl makes).
    expect(outpoints(sendCalls[0].selectedVtxos)).toEqual([`${sooner.txid}:1`])
  })

  it('400s cleanly (no spend) when every coin is pinned to a live game', async () => {
    // The admin-api regtest state: ONE bankroll coin, pinned by a pending v4
    // game whose liability is far below the balance — the liability guard alone
    // would let the send through and the blind SDK selection would spend the
    // pinned coin, breaking the game's co-fund.
    const reservedCoin = coin('77'.repeat(32), 2, 50_000)
    reservations.reserve('p0-53-send', [`${reservedCoin.txid}:2`], 2_000)
    const sendCalls: any[] = []
    const app = sendApp([reservedCoin], sendCalls)

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000 })

    expect(res.status).toBe(400)
    expect(res.body.freeSpendable).toBe(0)
    expect(res.body.error).toContain('force')
    expect(sendCalls).toHaveLength(0)
  })

  it('never selects a pending-recovery coin (the coin arkd would reject)', async () => {
    const stuck = coin('88'.repeat(32), 0, 80_000)
    const clean = coin('99'.repeat(32), 1, 30_000)
    const sendCalls: any[] = []
    const app = sendApp([stuck, clean], sendCalls, [`${stuck.txid}:0`])

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000 })

    expect(res.status).toBe(200)
    // The stuck coin is larger and un-reserved, but _sendImpl drops
    // pendingRecoveryOutpoints() from its candidate set — so do we. Selecting
    // it was prior-attempt C's failure: arkd rejects the spend at submit.
    expect(outpoints(sendCalls[0].selectedVtxos)).toEqual([`${clean.txid}:1`])

    // With ONLY the stuck coin left, the send is a clean 400 — not a doomed submit.
    const sendCalls2: any[] = []
    const app2 = sendApp([stuck], sendCalls2, [`${stuck.txid}:0`])
    const res2 = await request(app2).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000 })
    expect(res2.status).toBe(400)
    expect(sendCalls2).toHaveLength(0)
  })

  it('targets max(amount, dust) like _sendImpl — a sub-dust send needs dust-worth of coins', async () => {
    const tiny = coin('aa'.repeat(32), 3, 200) // below the 330 dust floor
    const sendCalls: any[] = []
    const app = sendApp([tiny], sendCalls)

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 100 })

    expect(res.status).toBe(400)
    expect(sendCalls).toHaveLength(0)
  })

  it('force:true keeps the blind operator hatch (no selectedVtxos)', async () => {
    const reservedCoin = coin('bb'.repeat(32), 4, 50_000)
    reservations.reserve('p0-53-send', [`${reservedCoin.txid}:4`], 2_000)
    const sendCalls: any[] = []
    const app = sendApp([reservedCoin], sendCalls)

    const res = await request(app).post('/api/wallet/send')
      .send({ address: HOUSE_ADDRESS, amount: 1000, force: true })

    expect(res.status).toBe(200)
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0].selectedVtxos).toBeUndefined()
  })
})

export {}
