/**
 * Tests for CoinflipEscrowV3ContractHandler and dual registration.
 */

// Mark this file as a module so its top-level identifiers are file-scoped
// (other *.unit.test.ts files also `require()` `schnorr` / declare the same
// names — without this each script's globals would clash under ts-jest's
// shared program in single-process mode).
export {}

/* eslint-disable @typescript-eslint/no-require-imports */
const { schnorr } = require('@noble/curves/secp256k1.js')
const { contractHandlers } = require('@arkade-os/sdk')
const {
  COINFLIP_ESCROW_TYPE,
  COINFLIP_ESCROW_V3_TYPE,
  CoinflipEscrowV3ContractHandler,
  CoinflipEscrowScriptV3,
  registerCoinflipContracts,
  digitHash,
} = require('arkade-coinflip')

function pk(seed: number) {
  return schnorr.getPublicKey(new Uint8Array(32).fill(seed))
}

const opts = {
  creatorPubkey: pk(0x10),
  playerPubkey: pk(0x20),
  serverPubkey: pk(0x30),
  creatorHash: digitHash({ digit: 0, salt: new Uint8Array(16).fill(0xaa) }),
  playerHash: digitHash({ digit: 1, salt: new Uint8Array(16).fill(0xbb) }),
  finalExpiration: 2_000_000_000n,
  refundPubkey: pk(0x20),
  exitDelay: 86_528n,
  oddsN: 2,
  oddsTarget: 1,
  oddsLo: 0,
  arkadeForfeit: {
    emulatorPubkey: pk(0x40),
    playerPayoutPkScript: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0x77)]),
    housePayoutPkScript: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0x88)]),
    playerStake: 50_000n,
    houseStake: 30_000n,
  },
}

describe('CoinflipEscrowV3ContractHandler', () => {
  it('exposes the right type tag', () => {
    expect(COINFLIP_ESCROW_V3_TYPE).toBe('coinflip-escrow-v3')
    expect(CoinflipEscrowV3ContractHandler.type).toBe('coinflip-escrow-v3')
  })

  it('round-trips serialize → deserialize → createScript', () => {
    const ser = CoinflipEscrowV3ContractHandler.serializeParams(opts)
    const a = new CoinflipEscrowScriptV3(opts)
    const b = CoinflipEscrowV3ContractHandler.createScript(ser) as InstanceType<typeof CoinflipEscrowScriptV3>
    // All ten leaves must match.
    expect(a.playerWinCovenant()[1]).toEqual(b.playerWinCovenant()[1])
    expect(a.creatorWinCovenant()[1]).toEqual(b.creatorWinCovenant()[1])
    expect(a.playerForfeit()[1]).toEqual(b.playerForfeit()[1])
    expect(a.refund()[1]).toEqual(b.refund()[1])
    expect(a.playerWinExit()[1]).toEqual(b.playerWinExit()[1])
    expect(a.creatorWinExit()[1]).toEqual(b.creatorWinExit()[1])
    expect(a.playerForfeitExit()[1]).toEqual(b.playerForfeitExit()[1])
    expect(a.refundExit()[1]).toEqual(b.refundExit()[1])
    expect(a.cooperativeSpend()[1]).toEqual(b.cooperativeSpend()[1])
    expect(a.cooperativeSpendExit()[1]).toEqual(b.cooperativeSpendExit()[1])
  })

  it('serializeParams produces hex strings for all binary fields', () => {
    const ser = CoinflipEscrowV3ContractHandler.serializeParams(opts)
    expect(typeof ser.creator).toBe('string')
    expect(ser.creator).toMatch(/^[0-9a-f]+$/)
    expect(typeof ser.creatorHash).toBe('string')
    expect(typeof ser.finalExpiration).toBe('string')
    expect(typeof ser.oddsN).toBe('string')
  })

  it('returns all 10 spending paths', () => {
    const script = new CoinflipEscrowScriptV3(opts) as InstanceType<typeof CoinflipEscrowScriptV3>
    const paths = CoinflipEscrowV3ContractHandler.getAllSpendingPaths(script)
    expect(paths.length).toBe(10)
  })

  it('selectPath returns null (coinflip builds spends directly)', () => {
    const script = new CoinflipEscrowScriptV3(opts) as InstanceType<typeof CoinflipEscrowScriptV3>
    expect(CoinflipEscrowV3ContractHandler.selectPath(script)).toBeNull()
  })
})

describe('registerCoinflipContracts — dual registration', () => {
  // The SDK's contractHandlers is a module-scoped singleton. The earlier
  // arkade-escrow.unit.test or escrow-contract.unit.test may have registered
  // the v2 handler already; that's fine since register is idempotent.
  it('registers both v2 and v3 handlers', () => {
    registerCoinflipContracts(contractHandlers)
    expect(contractHandlers.has(COINFLIP_ESCROW_TYPE)).toBe(true)
    expect(contractHandlers.has(COINFLIP_ESCROW_V3_TYPE)).toBe(true)
  })

  it('is idempotent', () => {
    registerCoinflipContracts(contractHandlers)
    registerCoinflipContracts(contractHandlers)
    expect(contractHandlers.has(COINFLIP_ESCROW_V3_TYPE)).toBe(true)
  })
})
