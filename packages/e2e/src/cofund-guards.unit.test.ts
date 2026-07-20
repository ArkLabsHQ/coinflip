/**
 * The house's anti-overdraw defenses on the v4 co-fund money path — REJECT-branch
 * unit tests. Mocked deps (repos.games.get returns a fixture V4State JSON; identity
 * is a house SingleKey), NO regtest. Mirrors v4-cooperative-exit-handler.unit.test.ts:
 * build a valid-ish co-fund arkTx + checkpoints by hand, tamper ONE field, and assert
 * handleV4Cofund / handleV4Play `rejects.toThrow(/…/)`.
 *
 * Guards covered (in handleV4Cofund → handleV4CofundInner, packages/server/src/
 * trustless-game-v4.ts):
 *   Guard 0 — the trailing (house) checkpoints must spend the reserved house
 *             outpoints, in order.
 *   Guard 1 — co-fund output 0 must equal the agreed pot amount + script.
 *   Guard 2 — the house contribution must be within [houseStake, houseStake+dust].
 * plus the stakeTopUp bound in handleV4Play (must be an integer in (0, dust]).
 *
 * The guards run SEQUENTIALLY, so each fixture is built correct up to the target
 * guard and trips exactly that one — the specific error message proves which guard
 * fired (an earlier guard would throw a different message). `wallet.arkProvider.
 * submitTx` is wired to throw loudly, so a guard that fails to reject surfaces as a
 * message mismatch (test failure) rather than a false pass.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
export {} // module scope
import { base64, hex } from '@scure/base'
import { Transaction, ArkAddress, SingleKey } from '@arkade-os/sdk'
import { CoinflipJointPotScript } from 'arkade-coinflip'
const { schnorr } = require('@noble/curves/secp256k1.js')
const server = require('arkade-coinflip-server')

// ── fixtures ────────────────────────────────────────────────────────────────
const xonlyOf = (b: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(b))
const p2tr = (b: number): Uint8Array => new Uint8Array([0x51, 0x20, ...xonlyOf(b)])
const h = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const HRP = 'tark'
const DUST = 546n

/** A minimal input the guards never read beyond outpoint/count (witnessUtxo keeps
 *  btc-signer's PSBT round-trip happy). */
const IN_SCRIPT = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0x01)])
function mkInput(txidHex: string, vout: number) {
  return { txid: hex.decode(txidHex), index: vout, witnessUtxo: { script: IN_SCRIPT, amount: 1000n } }
}
/** A checkpoint PSBT whose input 0 spends {txid, vout} — all Guard 0 reads. */
function mkCheckpoint(txidHex: string, vout: number, extraInputs = 0): string {
  const tx = new Transaction()
  tx.addInput(mkInput(txidHex, vout))
  for (let i = 0; i < extraInputs; i++) tx.addInput(mkInput(hex.encode(h(0xf0 + i)), i))
  return base64.encode(tx.toPSBT())
}

interface BuildOpts { playerStake?: number; houseStake?: number; houseInputVals?: number[] }
/** A persisted V4 state whose covenant/potAddress are derived from a REAL
 *  CoinflipJointPotScript, plus a matching house SingleKey. */
async function buildState(opts: BuildOpts = {}) {
  const player = SingleKey.fromRandomBytes()
  const house = SingleKey.fromRandomBytes()
  const playerPub = await player.xOnlyPublicKey()
  const housePub = await house.xOnlyPublicKey()
  const serverPub = xonlyOf(3)
  const playerStake = opts.playerStake ?? 1000
  const houseStake = opts.houseStake ?? 1000
  const pot = playerStake + houseStake
  const houseInputVals = opts.houseInputVals ?? [houseStake]

  const potScript = new CoinflipJointPotScript({
    creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey: serverPub,
    creatorHash: h(0xc0), playerHash: h(0xd0),
    finalExpiration: 1_900_000_000n, cancelDelay: 1_800_000_000n, exitDelay: 86_528n,
    oddsN: 2, oddsTarget: 1, oddsLo: 0, emulatorPubkey: xonlyOf(4),
    playerPayoutPkScript: p2tr(0xa0), housePayoutPkScript: p2tr(0xb0),
    playerStake: BigInt(playerStake), houseStake: BigInt(houseStake),
  })
  const potAddress = potScript.address(HRP, serverPub).encode()

  // Guard 0 reads txid/vout; Guard 2 reads value. leaf/tapTree only matter at signing
  // (never reached in a reject), so they're omitted.
  const houseInputs = houseInputVals.map((value, i) => ({ txid: hex.encode(h(0x50 + i)), vout: i, value }))

  const covenant = {
    creatorPubkey: hex.encode(housePub), playerPubkey: hex.encode(playerPub), serverPubkey: hex.encode(serverPub),
    creatorHash: hex.encode(h(0xc0)), playerHash: hex.encode(h(0xd0)),
    finalExpiration: 1_900_000_000, cancelDelay: 1_800_000_000, exitDelay: 86_528,
    oddsN: 2, oddsTarget: 1, oddsLo: 0, emulatorPubkey: hex.encode(xonlyOf(4)),
    playerPayoutPkScript: hex.encode(p2tr(0xa0)), housePayoutPkScript: hex.encode(p2tr(0xb0)),
    playerStake, houseStake,
  }
  const state = {
    protocolVersion: 'v4', finalExpiration: 1_900_000_000, setupExpiration: 0,
    oddsN: 2, oddsTarget: 1, oddsLo: 0, exitDelay: 86_528,
    pot, houseStake, potAddress, houseInputs, covenant,
  }
  return { state, house }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cofundDeps(state: any, house: any, opts: { status?: string; dust?: bigint } = {}) {
  return {
    repos: { games: {
      get: async () => ({ house_vtxos_json: JSON.stringify(state), status: opts.status ?? 'pending' }),
      update: async () => {},
    } },
    identity: house,
    arkInfo: { dust: opts.dust ?? DUST },
    // A guard that fails to reject would fall through to submit — make that loud.
    wallet: { arkProvider: { submitTx: async () => { throw new Error('REACHED_SUBMIT: a guard failed to reject') } } },
  }
}

interface CofundOver {
  playerCount?: number
  out0?: { script: Uint8Array; amount: bigint }
  extraOutputs?: { script: Uint8Array; amount: bigint }[]
  houseCps?: string[]
}
/** A co-fund request correct for every guard, with optional per-test tampering.
 *  arkTx inputs are checkpoint refs (Ark's checkpoint indirection) — the guards read
 *  only their COUNT — so their outpoints are arbitrary; the checkpoints carry the real
 *  spent outpoints Guard 0 checks. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildCofund(state: any, over: CofundOver = {}) {
  const m = state.houseInputs.length
  const k = over.playerCount ?? 1
  const total = k + m
  const potPkScript = ArkAddress.decode(state.potAddress).pkScript
  const out0 = over.out0 ?? { script: potPkScript, amount: BigInt(state.pot) }
  const outputs = [out0, ...(over.extraOutputs ?? [])]

  const tx = new Transaction()
  for (let i = 0; i < total; i++) tx.addInput(mkInput(hex.encode(h(0x70 + i)), i))
  for (const o of outputs) tx.addOutput({ script: o.script, amount: o.amount })
  const arkTx = base64.encode(tx.toPSBT())

  const playerCps = Array.from({ length: k }, (_, i) => mkCheckpoint(hex.encode(h(0x90 + i)), i))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const houseCps = over.houseCps ?? state.houseInputs.map((hi: any) => mkCheckpoint(hi.txid, hi.vout))
  return { arkTx, checkpoints: [...playerCps, ...houseCps] }
}

// ── Guard 0: trailing house checkpoints must spend the reserved outpoints, in order ──
describe('handleV4Cofund Guard 0 — house checkpoints must spend the reserved house inputs', () => {
  it('REJECTS a house checkpoint that spends the WRONG txid', async () => {
    const { state, house } = await buildState()
    const bad = buildCofund(state, { houseCps: [mkCheckpoint(hex.encode(h(0xee)), 0)] })
    await expect(server.handleV4Cofund('g0-txid', bad, cofundDeps(state, house)))
      .rejects.toThrow(/does not spend the reserved house input/)
  })

  it('REJECTS a house checkpoint that spends the right txid but the WRONG vout', async () => {
    const { state, house } = await buildState()
    const bad = buildCofund(state, { houseCps: [mkCheckpoint(state.houseInputs[0].txid, 9)] })
    await expect(server.handleV4Cofund('g0-vout', bad, cofundDeps(state, house)))
      .rejects.toThrow(/does not spend the reserved house input/)
  })

  it('REJECTS a house checkpoint that spends more than one input', async () => {
    const { state, house } = await buildState()
    const bad = buildCofund(state, { houseCps: [mkCheckpoint(state.houseInputs[0].txid, state.houseInputs[0].vout, 1)] })
    await expect(server.handleV4Cofund('g0-count', bad, cofundDeps(state, house)))
      .rejects.toThrow(/does not spend the reserved house input/)
  })

  it('REJECTS two house checkpoints supplied OUT OF ORDER (in-order requirement)', async () => {
    const { state, house } = await buildState({ houseInputVals: [1000, 500] })
    const hi0 = state.houseInputs[0], hi1 = state.houseInputs[1]
    // Swap: checkpoint[k+0] now spends houseInputs[1], checkpoint[k+1] spends houseInputs[0].
    const swapped = [mkCheckpoint(hi1.txid, hi1.vout), mkCheckpoint(hi0.txid, hi0.vout)]
    const bad = buildCofund(state, { houseCps: swapped })
    await expect(server.handleV4Cofund('g0-order', bad, cofundDeps(state, house)))
      .rejects.toThrow(/does not spend the reserved house input/)
  })
})

// ── Positive control: a fully-valid co-fund clears every guard ──
describe('handleV4Cofund — positive control (all guards pass on a correct co-fund)', () => {
  it('a correct co-fund PASSES Guards 0/1/2 and fails only downstream (sign/submit)', async () => {
    // Default fixture: houseStake 1000, Hsum 1000 → contribution == houseStake (in range);
    // output 0 = pot; the single house checkpoint spends the reserved outpoint in order.
    const { state, house } = await buildState()
    const good = buildCofund(state)
    let err: unknown
    try { await server.handleV4Cofund('valid', good, cofundDeps(state, house)) } catch (e) { err = e }
    // It must reject (the mock can't really sign/submit the arkTx), but NEVER at a guard —
    // which proves every reject test below is tripped SOLELY by its one tampered field.
    expect(err).toBeDefined()
    expect(String(err)).not.toMatch(/reserved house input|agreed pot|refusing to sign/)
  })
})

// ── Guard 1: output 0 must equal the agreed pot (amount + script) ──
describe('handleV4Cofund Guard 1 — output 0 must match the agreed pot', () => {
  it('REJECTS a wrong pot AMOUNT (correct script)', async () => {
    const { state, house } = await buildState()
    const potPkScript = ArkAddress.decode(state.potAddress).pkScript
    const bad = buildCofund(state, { out0: { script: potPkScript, amount: BigInt(state.pot) + 1n } })
    await expect(server.handleV4Cofund('g1-amount', bad, cofundDeps(state, house)))
      .rejects.toThrow(/output 0 does not match the agreed pot/)
  })

  it('REJECTS a wrong pot SCRIPT (correct amount)', async () => {
    const { state, house } = await buildState()
    // A valid but WRONG destination (the player-payout script, not the pot covenant).
    const bad = buildCofund(state, { out0: { script: p2tr(0xa0), amount: BigInt(state.pot) } })
    await expect(server.handleV4Cofund('g1-script', bad, cofundDeps(state, house)))
      .rejects.toThrow(/output 0 does not match the agreed pot/)
  })
})

// ── Guard 2: house contribution must be within [houseStake, houseStake+dust] ──
describe('handleV4Cofund Guard 2 — house contribution bounded to [houseStake, houseStake+dust]', () => {
  it('REJECTS an OVERDRAW: house coins 1600, no change returned → contribution 1600 > 1546', async () => {
    // Passes Guard 0 (correct house checkpoint) + Guard 1 (output 0 = pot). The malicious
    // co-fund omits the 600-sat house change → the house would over-contribute.
    const { state, house } = await buildState({ playerStake: 1000, houseStake: 1000, houseInputVals: [1600] })
    const bad = buildCofund(state) // output 0 = pot, no house-change output
    await expect(server.handleV4Cofund('g2-over', bad, cofundDeps(state, house)))
      .rejects.toThrow(/house contribution 1600 outside \[1000, 1546\]/)
  })

  it('REJECTS an UNDER-contribution: house coins 1000, 600 returned as change → contribution 400 < 1000', async () => {
    const { state, house } = await buildState({ playerStake: 1000, houseStake: 1000, houseInputVals: [1000] })
    const houseChange = { script: hex.decode(state.covenant.housePayoutPkScript), amount: 600n }
    const bad = buildCofund(state, { extraOutputs: [houseChange] })
    await expect(server.handleV4Cofund('g2-under', bad, cofundDeps(state, house)))
      .rejects.toThrow(/house contribution 400 outside \[1000, 1546\]/)
  })
})

// ── stakeTopUp bound in handleV4Play: integer in (0, dust] ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function playDeps(opts: { dust?: bigint; tiers?: string; pending?: number } = {}): any {
  return {
    repos: {
      config: { get: async (key: string) => (key === 'tiers' ? (opts.tiers ?? '[1000,5000,10000,50000]') : null) },
      games: { countPendingForPlayer: async () => opts.pending ?? 0 },
    },
    arkInfo: { dust: opts.dust ?? DUST },
  }
}
function playReq(stakeTopUp: number) {
  return {
    tier: 1000, playerPubkey: hex.encode(h(0x01)), playerHash: hex.encode(h(0x02)),
    playerPayoutAddress: 'ark1dummy', playerChangeAddress: 'ark1dummy', stakeTopUp,
  }
}

describe('handleV4Play — stakeTopUp must be an integer in (0, dust]', () => {
  it('REJECTS a stakeTopUp GREATER than dust', async () => {
    await expect(server.handleV4Play(playReq(547), playDeps())).rejects.toThrow(/Invalid stakeTopUp/)
  })
  it('REJECTS a NEGATIVE stakeTopUp', async () => {
    await expect(server.handleV4Play(playReq(-1), playDeps())).rejects.toThrow(/Invalid stakeTopUp/)
  })
  it('REJECTS a NON-INTEGER stakeTopUp', async () => {
    await expect(server.handleV4Play(playReq(2.5), playDeps())).rejects.toThrow(/Invalid stakeTopUp/)
  })
})
