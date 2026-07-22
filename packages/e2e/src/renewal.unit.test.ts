/**
 * Deterministic unit tests for the renewal gate + tick (no regtest).
 *
 * The production renewal timer settles ONLY when shouldRenew says so, but the
 * gate must look through the RENEWAL buffer (SDK-default 3 days), not /play's
 * 30-min SELECTION buffer it originally reused: with a 30-min gate the timer
 * had a single half-hour window in a multi-day batch cycle to be alive and
 * healthy — the production 1M-sat loss shipped through exactly that hole (the
 * timer ran for hours and never once logged `settling`, then arkd swept the
 * batch and nothing recovered it).
 *
 * runRenewalTick is additionally the swept-fund RECOVERY driver (a swept
 * VTXO trips the gate via the isExpired clause and rides the renewal settle
 * back in) and must be wedge-proof: every await inside is timeout-bounded so
 * one black-holed SDK call can't latch the in-flight guard forever.
 *
 * The expiry-driven path needs a time-based-expiry network to exercise live
 * (regtest uses block-height batchExpiry), but the gating decision is pure.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import { ArkAddress, CSVMultisigTapscript } from '@arkade-os/sdk'
import { hex } from '@scure/base'
const {
  shouldRenew,
  vtxoNeedsRenewal,
  selectableHouseVtxos,
  runRenewalTick,
  RENEWAL_EXPIRY_BUFFER_MS,
  VTXO_LIFETIME_BUFFER_MS,
} = require('arkade-coinflip-server/dist/game-engine.js')
const { houseVtxoCache } = require('arkade-coinflip-server/dist/vtxo-pool.js')

const HOUSE_ADDRESS = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark').encode()
const HOUR = 3600_000

const vtxo = (txid: string, batchExpiry: number | undefined, state = 'settled', value = 50_000) => ({
  txid,
  vout: 0,
  value,
  virtualStatus: { state, batchExpiry },
  status: { confirmed: false },
  createdAt: new Date(),
})

describe('shouldRenew (renewal gating)', () => {
  it('does NOT renew when there is nothing to do (no per-poll settle)', () => {
    expect(shouldRenew(0, 0)).toBe(false)
  })
  it('renews when house VTXOs are expiring soon', () => {
    expect(shouldRenew(1, 0)).toBe(true)
    expect(shouldRenew(5, 0)).toBe(true)
  })
  it('renews when there are boarding deposits to confirm into Ark', () => {
    expect(shouldRenew(0, 5000)).toBe(true)
    expect(shouldRenew(0, 1)).toBe(true)
  })
  it('renews when both conditions hold', () => {
    expect(shouldRenew(3, 20000)).toBe(true)
  })
})

describe('renewal buffer vs /play selection buffer (the decoupling)', () => {
  it('renews on the SDK-default 3-day threshold, far wider than the selection buffer', () => {
    // SDK DEFAULT_SETTLEMENT_CONFIG.vtxoThreshold = 259_200 s. The renewal
    // buffer surviving multi-day outages is the loss-class fix; /play only
    // needs a coin spendable through one game setup.
    expect(RENEWAL_EXPIRY_BUFFER_MS).toBe(259_200_000)
    expect(RENEWAL_EXPIRY_BUFFER_MS).toBeGreaterThan(VTXO_LIFETIME_BUFFER_MS)
  })

  it('vtxoNeedsRenewal: a coin expiring in 2 days needs renewal but is still /play-selectable', () => {
    const twoDays = vtxo('aa'.repeat(32), Date.now() + 48 * HOUR)
    expect(vtxoNeedsRenewal(twoDays, RENEWAL_EXPIRY_BUFFER_MS)).toBe(true)
    expect(vtxoNeedsRenewal(twoDays, VTXO_LIFETIME_BUFFER_MS)).toBe(false)
  })

  it('vtxoNeedsRenewal: healthy far-from-expiry and no-expiry coins do not', () => {
    expect(vtxoNeedsRenewal(vtxo('bb'.repeat(32), Date.now() + 10 * 24 * HOUR), RENEWAL_EXPIRY_BUFFER_MS)).toBe(false)
    // No batchExpiry (e.g. a preconfirmed chain with none recorded): nothing
    // to renew against; the coin recovers via the swept clause if ever swept.
    expect(vtxoNeedsRenewal(vtxo('cc'.repeat(32), undefined), RENEWAL_EXPIRY_BUFFER_MS)).toBe(false)
  })

  it('vtxoNeedsRenewal: swept and already-expired coins need it regardless of buffer (recovery)', () => {
    // isVtxoExpiringSoon is FALSE once expiry has passed — only the
    // isExpired clause covers these, and it must, or swept funds are
    // invisible to the gate forever.
    expect(vtxoNeedsRenewal(vtxo('dd'.repeat(32), Date.now() - HOUR, 'swept'), VTXO_LIFETIME_BUFFER_MS)).toBe(true)
    expect(vtxoNeedsRenewal(vtxo('ee'.repeat(32), Date.now() - HOUR), RENEWAL_EXPIRY_BUFFER_MS)).toBe(true)
  })

  it('selectableHouseVtxos partitions differently under the two buffers', () => {
    const twoDays = vtxo('ff'.repeat(32), Date.now() + 48 * HOUR)
    // /play keeps using it…
    expect(selectableHouseVtxos([twoDays]).selectable).toHaveLength(1)
    // …while the renewal tick already schedules it for re-anchoring.
    expect(selectableHouseVtxos([twoDays], RENEWAL_EXPIRY_BUFFER_MS).dropped).toHaveLength(1)
  })
})

describe('runRenewalTick (gate → settle chain, wedge-proofing, visibility)', () => {
  let logSpy: jest.SpyInstance
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    houseVtxoCache.invalidate()
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    houseVtxoCache.invalidate()
  })

  const logged = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n')

  function tickWallet(overrides: any = {}) {
    return {
      dustAmount: 330n,
      arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: -1n }) },
      getVtxoManager: async () => ({
        migrateDeprecatedSignerVtxos: async () => ({ rotated: false, expired: [], signers: [] }),
      }),
      getBoardingUtxos: async () => [],
      getVtxos: async () => [],
      getAddress: async () => HOUSE_ADDRESS,
      settle: async () => 'txid',
      ...overrides,
    }
  }

  it('recovers a swept house VTXO end-to-end (the production-loss regression)', async () => {
    // A wallet whose ONLY coin was swept by arkd: the gate must fire and the
    // settle must reclaim it. In the lost-funds incident nothing on the
    // server ever called the recovery path; this pins the full chain
    // getVtxos → gate → renewSettle → settle(inputs=[swept]).
    const swept = vtxo('ab'.repeat(32), Date.now() - HOUR, 'swept', 1_000_000)
    const settleCalls: any[][] = []
    const deps = {
      wallet: tickWallet({
        getVtxos: async () => [swept],
        settle: async (...args: any[]) => { settleCalls.push(args); return 'txid' },
      }),
    } as any

    await runRenewalTick(deps)

    expect(settleCalls).toHaveLength(1)
    expect(settleCalls[0][0].inputs.map((v: any) => v.txid)).toEqual([swept.txid])
    expect(settleCalls[0][0].outputs[0].amount).toBe(1_000_000n)
    expect(logged()).toContain('settling: 1 expiring/recoverable VTXO(s)')
  })

  it('does not settle a healthy pool, but logs the expiry status line', async () => {
    const healthy = vtxo('cd'.repeat(32), Date.now() + 10 * 24 * HOUR)
    const settleCalls: any[] = []
    const deps = {
      wallet: tickWallet({
        getVtxos: async () => [healthy],
        settle: async (...args: any[]) => { settleCalls.push(args); return 'txid' },
      }),
    } as any

    await runRenewalTick(deps)

    expect(settleCalls).toHaveLength(0)
    // The pre-sweep visibility the loss lacked: nearest expiry + recoverable
    // sats every tick, so silence itself becomes diagnosable.
    expect(logged()).toMatch(/pool status: 1 vtxo\(s\), nearest batch expiry ~\d+h/)
    expect(logged()).toContain('0 recoverable sat(s)')
  })

  it('surfaces recoverable sats in the status line', async () => {
    const swept = vtxo('ef'.repeat(32), Date.now() - HOUR, 'swept', 123_456)
    const deps = { wallet: tickWallet({ getVtxos: async () => [swept] }) } as any
    await runRenewalTick(deps)
    expect(logged()).toContain('123456 recoverable sat(s)')
  })

  it('ignores an UNCONFIRMED boarding deposit (the settle could not confirm it anyway)', async () => {
    const settleCalls: any[] = []
    const deps = {
      wallet: tickWallet({
        getBoardingUtxos: async () => [
          { txid: '11'.repeat(32), vout: 0, value: 50_000, status: { confirmed: false } },
        ],
        settle: async (...args: any[]) => { settleCalls.push(args); return 'txid' },
      }),
    } as any

    await runRenewalTick(deps)

    // Pre-fix the gate read balance.boarding.total (confirmed + unconfirmed),
    // fired a settle that then found nothing eligible, and warned every tick.
    expect(settleCalls).toHaveLength(0)
  })

  it('settles a CONFIRMED boarding deposit into Ark', async () => {
    const boardingUtxo = { txid: '22'.repeat(32), vout: 0, value: 80_000, status: { confirmed: true } }
    // Real CSV exit leaf so the params builder can decode the boarding
    // timelock; blocks-type → the builder consults the chain tip, and with no
    // block_height on the utxo the expiry check is a clean "not expired".
    const exitScript = hex.encode(
      CSVMultisigTapscript.encode({
        timelock: { type: 'blocks', value: 144n },
        pubkeys: [new Uint8Array(32).fill(7)],
      }).script,
    )
    const settleCalls: any[][] = []
    const deps = {
      wallet: tickWallet({
        boardingTapscript: { exitScript },
        onchainProvider: { getChainTip: async () => ({ height: 100 }) },
        getBoardingUtxos: async () => [boardingUtxo],
        settle: async (...args: any[]) => { settleCalls.push(args); return 'txid' },
      }),
    } as any

    await runRenewalTick(deps)

    expect(settleCalls).toHaveLength(1)
    expect(settleCalls[0][0].inputs.map((u: any) => u.txid)).toEqual([boardingUtxo.txid])
    expect(settleCalls[0][0].outputs[0].amount).toBe(80_000n)
  })

  it('REJECTS (not wedges) when a wallet read black-holes — getBoardingUtxos', async () => {
    const deps = {
      wallet: tickWallet({
        getBoardingUtxos: () => new Promise(() => {}), // never settles
      }),
    } as any
    // Pre-fix a hung read here left startRenewalTimer's in-flight guard
    // latched forever: every later tick returned silently, indistinguishable
    // from a healthy idle timer — the loss-incident log signature.
    await expect(runRenewalTick(deps, undefined, { syncTimeoutMs: 200 })).rejects.toThrow(/timed out/)
  })

  it('REJECTS (not wedges) when the VTXO re-sync stalls — getVtxos', async () => {
    // Delayed (not infinite) resolve so the shared houseVtxoCache in-flight
    // slot drains before the next test.
    const slow = new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 1_000))
    const deps = { wallet: tickWallet({ getVtxos: () => slow }) } as any
    await expect(runRenewalTick(deps, undefined, { syncTimeoutMs: 200 })).rejects.toThrow(/timed out/)
    await slow // drain the cache's in-flight fetch before the next test runs
  })
})

export {}
