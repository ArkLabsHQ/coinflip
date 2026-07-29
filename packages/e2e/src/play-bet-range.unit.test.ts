/**
 * /play bet validation after the tier whitelist was replaced by a range.
 *
 * The cap test is the load-bearing one: the client-side envelope is advisory,
 * so if the server didn't independently enforce the per-bet fraction a crafted
 * request could still commit the entire bankroll and defeat the cap.
 */
export {}

/* eslint-disable @typescript-eslint/no-require-imports */
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
const { schnorr } = require('@noble/curves/secp256k1.js')
const server = require('arkade-coinflip-server')
const emulatorModule = require('arkade-coinflip-server/dist/emulator.js')
const { BetExceedsCapacityError, houseVtxoCache } = require('arkade-coinflip-server/dist/vtxo-pool.js')

// `houseVtxoCache` is a module singleton and /play now reads the WARM snapshot
// rather than forcing a live sync. These cases swap `deps.wallet.getVtxos`
// wholesale between them, so the empty-wallet factory below would otherwise
// leave an empty snapshot that the later capacity cases inherit — they would
// measure "0 sat free" and the cap assertions would be meaningless.
//
// This is a harness fix, not a relaxed assertion: production never swaps a
// wallet under the cache. It mutates house coins only through paths that tell
// the cache — the co-fund removes its spent inputs, the split and the renewal
// settle invalidate. The harness mirrors that discipline.
beforeEach(() => houseVtxoCache.invalidate())

const DUST = 330

/** Bare mock for the pure range-check tests below: they all throw during tier
 *  validation, before handleV4Play ever touches the emulator, identity, or
 *  wallet — so this incomplete shape is fine, and deliberately stays minimal. */
function makeDeps(overrides: Record<string, string> = {}) {
  const config: Record<string, string> = {
    tiers: '[330,1000,5000,10000,50000]',
    variable_odds_edge_bps: '300',
    max_bet_fraction_bps: '2500',
    ...overrides,
  }
  return {
    arkInfo: { dust: BigInt(DUST) },
    wallet: { getVtxos: async () => [] },
    identity: { compressedPublicKey: async () => new Uint8Array(33) },
    repos: {
      config: { get: async (k: string) => config[k], all: async () => config },
      games: { countPendingForPlayer: async () => 0, save: async () => undefined },
    },
  }
}

const PLAYER = '02'.padEnd(66, 'a')

// ── full fixture: real keys + addresses, for any test that must clear validation ──
//
// Once past the tier-range check, handleV4Play unconditionally probes the
// emulator and decodes real pubkeys/addresses (identity, arkInfo.signerPubkey,
// req.playerPayoutAddress, wallet.getAddress()) before it ever looks at house
// VTXOs — so a test that needs to run PAST validation needs all of these to be
// real, not just the VTXO set. Real secp256k1 points are required because
// CoinflipJointPotScript taproot-tweaks them (a placeholder like an all-zero
// key is not a valid curve point and throws).
const xonlyOf = (b: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(b))

const HOUSE_XONLY = xonlyOf(0x11)
const HOUSE_COMPRESSED = new Uint8Array([2, ...HOUSE_XONLY])
const SERVER_XONLY = xonlyOf(0x22)
const PLAYER_XONLY = xonlyOf(0x33)
const EMULATOR_XONLY = xonlyOf(0x44)
const HOUSE_ADDRESS = new ArkAddress(new Uint8Array(32).fill(0x77), new Uint8Array(32).fill(0x88), 'tark').encode()
const PLAYER_PAYOUT_ADDRESS = new ArkAddress(new Uint8Array(32).fill(0x55), new Uint8Array(32).fill(0x66), 'tark').encode()

/** A house VTXO whose forfeit leaf embeds HOUSE_XONLY, so `choose()` treats it
 *  as co-signable. The leaf is never actually spent in these tests
 *  (handleV4Play only reads it via tapLeafHasKey + serializeTapLeaf), so a
 *  minimal fake shape is enough. */
function houseCoin(txid: string, vout: number, value: number) {
  return {
    txid, vout, value,
    virtualStatus: { state: 'settled' as const },
    forfeitTapLeafScript: [
      { version: 0xc0, internalKey: xonlyOf(0x99), merklePath: [] as Uint8Array[] },
      new Uint8Array([...HOUSE_XONLY, 0xc0]),
    ],
    tapTree: new Uint8Array([0]),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function capDeps(vtxos: any[], overrides: Record<string, string> = {}) {
  const config: Record<string, string> = {
    tiers: '[330,1000,5000,10000,50000]',
    variable_odds_edge_bps: '300',
    max_bet_fraction_bps: '2500',
    ...overrides,
  }
  return {
    arkInfo: { dust: BigInt(DUST), signerPubkey: hex.encode(SERVER_XONLY) },
    wallet: { getVtxos: async () => vtxos, getAddress: async () => HOUSE_ADDRESS },
    identity: { compressedPublicKey: async () => HOUSE_COMPRESSED },
    repos: {
      config: { get: async (k: string) => config[k], all: async () => config },
      games: { countPendingForPlayer: async () => 0, save: async () => undefined },
    },
  }
}

function capReq(tier: number) {
  return {
    tier,
    playerPubkey: hex.encode(PLAYER_XONLY),
    playerHash: hex.encode(new Uint8Array(32).fill(0xee)),
    playerPayoutAddress: PLAYER_PAYOUT_ADDRESS,
    playerChangeAddress: PLAYER_PAYOUT_ADDRESS,
  }
}

// handleV4Play has no way to inject the emulator config — loadEmulatorConfig is
// a real network probe cached at module scope (packages/server/src/emulator.ts).
// Patched here for the WHOLE file (not scoped to one describe) so every test
// sees the SAME behavior whether or not a real emulator is reachable: CI's
// regtest stack runs one, local dev usually doesn't, and a test pinned to only
// one of those environments (asserting on whichever error THAT environment
// happens to throw first) is exactly the bug this fixes. Requiring the built
// dist module directly (same pattern as reservation-safe-selfspend.unit.test.ts)
// resolves to the identical CJS singleton play.js calls, so reassigning its
// export here is visible there too — and since it fully replaces the export,
// the real network probe never runs in this file regardless of environment.
// Safe for the plain range-check tests too: they throw during tier validation,
// before handleV4Play ever calls loadEmulatorConfig.
let originalLoadEmulatorConfig: typeof emulatorModule.loadEmulatorConfig
beforeAll(() => {
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

describe('/play bet amount range', () => {
  it('rejects a bet below railMin (dust + 1)', async () => {
    await expect(
      server.handleV4Play({ tier: DUST, playerPubkey: PLAYER, playerHash: 'ab' }, makeDeps()),
    ).rejects.toThrow(/Invalid bet amount/)
  })

  it('rejects a bet above railMax', async () => {
    await expect(
      server.handleV4Play({ tier: 50_001, playerPubkey: PLAYER, playerHash: 'ab' }, makeDeps()),
    ).rejects.toThrow(/Invalid bet amount/)
  })

  it('rejects a non-integer bet', async () => {
    await expect(
      server.handleV4Play({ tier: 1000.5, playerPubkey: PLAYER, playerHash: 'ab' }, makeDeps()),
    ).rejects.toThrow(/Invalid bet amount/)
  })

  it('accepts an off-tier amount that the old whitelist would have rejected', async () => {
    // 1337 was never a configured tier. It must clear the range check and reach
    // the SAME downstream failure in every environment (see the file-level
    // loadEmulatorConfig patch above): with zero free house VTXOs the per-bet
    // cap is 0, so any positive bet exceeds it — deterministically, whether or
    // not a real emulator happens to be reachable. Asserting the specific
    // error TYPE (BetExceedsCapacityError, not the plain Error the range check
    // throws) still fails loudly if validation ever wrongly rejects 1337.
    let err: unknown
    try {
      await server.handleV4Play(capReq(1337), capDeps([]))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BetExceedsCapacityError)
    expect(String(err)).toMatch(/per-bet cap is 0 sat/)
  })
})

// ── per-bet exposure cap ─────────────────────────────────────────────────────
//
// The cap check runs AFTER the emulator probe and the ArkAddress decodes in
// handleV4Play, so reaching it needs the full fixture above (real secp256k1
// points, valid Ark addresses, a co-signable house VTXO).
describe('/play per-bet exposure cap', () => {
  it('REJECTS a bet whose house stake exceeds the per-bet cap', async () => {
    // freeTotal = 4000, cap = floor(4000 * 2500 / 10000) = 1000; tier 1337 (a
    // valid rail amount) needs a 1337-sat house stake, which exceeds the cap.
    const vtxos = [houseCoin('aa'.repeat(32), 0, 4000)]
    let err: unknown
    try {
      await server.handleV4Play(capReq(1337), capDeps(vtxos))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BetExceedsCapacityError)
    expect(String(err)).toMatch(/per-bet cap is 1000 sat/)
  })

  it('ACCEPTS a bet whose house stake is within the per-bet cap', async () => {
    // freeTotal = 40000, cap = floor(40000 * 2500 / 10000) = 10000; tier 1000
    // needs only a 1000-sat house stake, well within the cap — the request
    // must clear the cap check and resolve with the expected house stake.
    const vtxos = [houseCoin('bb'.repeat(32), 0, 40000)]
    const result = await server.handleV4Play(capReq(1000), capDeps(vtxos))
    expect(result.houseStake).toBe(1000)
  })
})
