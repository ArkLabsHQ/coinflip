/**
 * Tests for the coinflip-escrow ContractHandler — the SDK-registered
 * contract type that lets the ContractManager/ContractWatcher track each
 * game's escrow VTXO and emit vtxo_received / vtxo_spent events.
 *
 * The load-bearing property is a LOSSLESS round-trip: re-deriving the
 * escrow script through the handler
 * (`createScript(serializeParams(opts))`) MUST reproduce the byte-identical
 * taproot output of `new CoinflipEscrowScript(opts)`. We assert this for
 * both the 50/50 coin and a variable-odds game, plus idempotent
 * registration against a fake registry.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { schnorr } = require('@noble/curves/secp256k1.js')
const {
  CoinflipEscrowScript,
  CoinflipEscrowContractHandler,
  COINFLIP_ESCROW_TYPE,
  registerCoinflipContracts,
} = require('arkade-coinflip')

const REGTEST_HRP = 'tark'

/** 32-byte x-only pubkey from a random scalar. */
function randomXOnlyPubkey(): Uint8Array {
  const sk = new Uint8Array(32)
  crypto.getRandomValues(sk)
  return schnorr.getPublicKey(sk)
}

/** N random bytes. */
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

/** A P2TR-shaped pkScript (OP_1 <32-byte x-only key>). */
function randomP2trPkScript(): Uint8Array {
  return new Uint8Array([0x51, 0x20, ...randomXOnlyPubkey()])
}

/** Build a realistic escrow options object (50/50 coin unless odds passed). */
function makeOpts(odds?: { oddsN: number; oddsTarget: number; oddsLo: number }) {
  const playerPubkey = randomXOnlyPubkey()
  const base = {
    creatorPubkey: randomXOnlyPubkey(),
    playerPubkey,
    serverPubkey: randomXOnlyPubkey(),
    creatorHash: randomBytes(32),
    playerHash: randomBytes(32),
    finalExpiration: 1_900_000_000n, // unix seconds (> CLTV height threshold)
    refundPubkey: playerPubkey, // player escrow
    exitDelay: 86_528n, // 24h-ish, multiple of 512
    arkadeForfeit: {
      emulatorPubkey: randomXOnlyPubkey(),
      playerPayoutPkScript: randomP2trPkScript(),
      housePayoutPkScript: randomP2trPkScript(),
      playerStake: 50_000n,
      houseStake: 30_000n,
    },
  }
  return odds ? { ...base, ...odds } : base
}

/**
 * Re-derive the script through the handler and assert byte-identity vs the
 * directly-constructed script: equal pkScript (hex) AND equal address.
 */
function assertRoundTripIdentical(opts: any): void {
  const direct = new CoinflipEscrowScript(opts)
  const serialized = CoinflipEscrowContractHandler.serializeParams(opts)
  const rebuilt = CoinflipEscrowContractHandler.createScript(serialized)

  const directPkScript = Buffer.from(direct.pkScript).toString('hex')
  const rebuiltPkScript = Buffer.from(rebuilt.pkScript).toString('hex')
  expect(rebuiltPkScript).toBe(directPkScript)

  const directAddr = direct.address(REGTEST_HRP, opts.serverPubkey).encode()
  const rebuiltAddr = rebuilt.address(REGTEST_HRP, opts.serverPubkey).encode()
  expect(rebuiltAddr).toBe(directAddr)
}

describe('coinflip-escrow ContractHandler: lossless round-trip', () => {
  it('handler type is coinflip-escrow', () => {
    expect(CoinflipEscrowContractHandler.type).toBe(COINFLIP_ESCROW_TYPE)
    expect(COINFLIP_ESCROW_TYPE).toBe('coinflip-escrow')
  })

  it('round-trips a COIN (no odds) to a byte-identical escrow script', () => {
    const opts = makeOpts()
    // Sanity: the coin opts carry no odds fields, and the serialized form
    // omits them entirely (so they deserialize back to undefined, not 0).
    const serialized = CoinflipEscrowContractHandler.serializeParams(opts)
    expect(serialized.oddsN).toBeUndefined()
    expect(serialized.oddsTarget).toBeUndefined()
    expect(serialized.oddsLo).toBeUndefined()

    assertRoundTripIdentical(opts)
  })

  it('round-trips a VARIABLE-ODDS game to a byte-identical escrow script, odds survive', () => {
    // "Roll 4+ on a d6": n=6 outcomes, player wins when 3 <= roll < 6.
    const opts = makeOpts({ oddsN: 6, oddsTarget: 6, oddsLo: 3 })

    const serialized = CoinflipEscrowContractHandler.serializeParams(opts)
    // Odds fields survive serialization...
    expect(serialized.oddsN).toBe('6')
    expect(serialized.oddsTarget).toBe('6')
    expect(serialized.oddsLo).toBe('3')
    // ...and deserialize back to the original numeric values.
    const back = CoinflipEscrowContractHandler.deserializeParams(serialized)
    expect(back.oddsN).toBe(6)
    expect(back.oddsTarget).toBe(6)
    expect(back.oddsLo).toBe(3)

    assertRoundTripIdentical(opts)
  })

  it('coin vs variable-odds produce different scripts (the odds actually change the taptree)', () => {
    // Shared keys/hashes so ONLY the odds differ.
    const coin = makeOpts()
    const variable = { ...coin, oddsN: 6, oddsTarget: 6, oddsLo: 3 }
    const coinPk = Buffer.from(new CoinflipEscrowScript(coin).pkScript).toString('hex')
    const varPk = Buffer.from(new CoinflipEscrowScript(variable).pkScript).toString('hex')
    expect(varPk).not.toBe(coinPk)
  })
})

describe('registerCoinflipContracts: idempotent registration', () => {
  function fakeRegistry() {
    const registered = new Set<string>()
    return {
      registered,
      register(h: { type: string }) {
        if (registered.has(h.type)) {
          throw new Error(`duplicate registration for ${h.type}`)
        }
        registered.add(h.type)
      },
      has(t: string) {
        return registered.has(t)
      },
    }
  }

  it('registers the coinflip-escrow handler', () => {
    const reg = fakeRegistry()
    registerCoinflipContracts(reg)
    expect(reg.registered.has(COINFLIP_ESCROW_TYPE)).toBe(true)
    expect(reg.registered.size).toBe(1)
  })

  it('is idempotent — calling twice does not throw or double-register', () => {
    const reg = fakeRegistry()
    registerCoinflipContracts(reg)
    expect(() => registerCoinflipContracts(reg)).not.toThrow()
    expect(reg.registered.size).toBe(1)
  })
})

export {}
