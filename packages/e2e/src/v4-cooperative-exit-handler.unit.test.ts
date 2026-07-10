/**
 * Unit tests for handleV4CooperativeExit (server) — the house co-signs the
 * client's leaf-7 cooperativeSpendExit split-back, fail-closed. No regtest:
 * mock deps (repos.games.get returns a fixture V4 state; deps.identity is the
 * house SingleKey). Proves (a) the happy path yields a fully-signed tx, and
 * (b) the house REFUSES to co-sign anything but its exact expected split-back.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
export {} // module scope
const { CoinflipJointPotScript, buildCooperativeSpendExitTx } = require('arkade-coinflip')
const { SingleKey, Transaction } = require('@arkade-os/sdk')
const { hex, base64 } = require('@scure/base')
const { schnorr } = require('@noble/curves/secp256k1.js')
const server = require('arkade-coinflip-server')

const xonlyOf = (b: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(b))
const p2tr = (b: number): Uint8Array => new Uint8Array([0x51, 0x20, ...xonlyOf(b)])
const h = (b: number): Uint8Array => new Uint8Array(32).fill(b)

const STAKE = 50_000n
const FEE = 1_000
const POT_ONCHAIN = { txid: 'bb'.repeat(32), vout: 0, value: Number(2n * STAKE) }

/** Build a game whose covenant uses the given player/house x-only keys, a
 *  client-built exit tx already signed by the PLAYER, and mock deps. Pass a
 *  `status` to exercise the terminal-state guard (default: undefined = pending). */
async function fixture(status?: string) {
  const player = SingleKey.fromRandomBytes()
  const house = SingleKey.fromRandomBytes()
  const playerPub = await player.xOnlyPublicKey()
  const housePub = await house.xOnlyPublicKey()

  const covenant = {
    creatorPubkey: hex.encode(housePub), playerPubkey: hex.encode(playerPub), serverPubkey: hex.encode(xonlyOf(3)),
    creatorHash: hex.encode(h(0xc0)), playerHash: hex.encode(h(0xd0)),
    finalExpiration: 1_900_000_000, cancelDelay: 1_800_000_000, exitDelay: 86_528,
    oddsN: 2, oddsTarget: 1, oddsLo: 0, emulatorPubkey: hex.encode(xonlyOf(4)),
    playerPayoutPkScript: hex.encode(p2tr(0xa0)), housePayoutPkScript: hex.encode(p2tr(0xb0)),
    playerStake: STAKE.toString(), houseStake: STAKE.toString(),
  }
  const pot = new CoinflipJointPotScript({
    creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey: xonlyOf(3),
    creatorHash: h(0xc0), playerHash: h(0xd0), finalExpiration: 1_900_000_000n, cancelDelay: 1_800_000_000n,
    exitDelay: 86_528n, oddsN: 2, oddsTarget: 1, oddsLo: 0, emulatorPubkey: xonlyOf(4),
    playerPayoutPkScript: p2tr(0xa0), housePayoutPkScript: p2tr(0xb0), playerStake: STAKE, houseStake: STAKE,
  })
  const { tx } = buildCooperativeSpendExitTx({
    pot, potOnchain: POT_ONCHAIN, playerStake: STAKE, houseStake: STAKE,
    playerPayoutPkScript: p2tr(0xa0), housePayoutPkScript: p2tr(0xb0), exitDelay: 86_528n, feeSats: BigInt(FEE),
  })
  const playerSigned = await player.sign(tx, [0])

  const state = { protocolVersion: 'v4', cofundTxid: POT_ONCHAIN.txid, covenant }
  const deps = { repos: { games: { get: async () => ({ house_vtxos_json: JSON.stringify(state), status }) } }, identity: house }
  return { deps, playerSigned, pot }
}

describe('handleV4CooperativeExit (house co-sign, fail-closed)', () => {
  it('co-signs a matching split-back → a fully-signable tx', async () => {
    const { deps, playerSigned } = await fixture()
    const res = await server.handleV4CooperativeExit('g1', {
      exitTxPsbt: base64.encode(playerSigned.toPSBT()), potOnchain: POT_ONCHAIN, feeSats: FEE,
    }, deps)
    // Both parties signed → the returned PSBT finalizes without error.
    const finalTx = Transaction.fromPSBT(base64.decode(res.exitTxPsbt))
    expect(() => finalTx.finalize()).not.toThrow()
    expect(finalTx.hex.length).toBeGreaterThan(0)
  })

  it('REFUSES to co-sign a tx whose output was tampered', async () => {
    const { deps, pot } = await fixture()
    // Build an exit that pays the player MORE (steal from the house).
    const { tx: greedy } = buildCooperativeSpendExitTx({
      pot, potOnchain: POT_ONCHAIN, playerStake: STAKE + 400n, houseStake: STAKE - 400n,
      playerPayoutPkScript: p2tr(0xa0), housePayoutPkScript: p2tr(0xb0), exitDelay: 86_528n, feeSats: BigInt(FEE),
    })
    // No need to sign — the fail-closed shape check runs BEFORE the house co-signs.
    await expect(server.handleV4CooperativeExit('g1', {
      exitTxPsbt: base64.encode(greedy.toPSBT()), potOnchain: POT_ONCHAIN, feeSats: FEE,
    }, deps)).rejects.toThrow(/output .* mismatch|co-signs only the exact split-back/)
  })

  it('404s an unknown / non-co-funded game', async () => {
    const deps = { repos: { games: { get: async () => null } }, identity: SingleKey.fromRandomBytes() }
    await expect(server.handleV4CooperativeExit('nope', {
      exitTxPsbt: 'x', potOnchain: POT_ONCHAIN, feeSats: FEE,
    }, deps)).rejects.toThrow(/Game not found/)
  })

  it('REFUSES once the game is resolved (pot already spent)', async () => {
    // The pot was already settled/refunded — matching the reveal + refund
    // siblings, the exit must refuse rather than co-sign a doomed double-spend.
    const { deps, playerSigned } = await fixture('resolved')
    await expect(server.handleV4CooperativeExit('g1', {
      exitTxPsbt: base64.encode(playerSigned.toPSBT()), potOnchain: POT_ONCHAIN, feeSats: FEE,
    }, deps)).rejects.toThrow(/already resolved/)
  })

  it('REFUSES a tx whose input witnessUtxo value disagrees with the pot', async () => {
    // Outpoint, sequence, and outputs all stay honest; only the declared input
    // value is inflated. The house co-sign commits to the spent amount via the
    // taproot sighash, so it must refuse the internally-inconsistent input.
    const { deps, pot } = await fixture()
    const { tx } = buildCooperativeSpendExitTx({
      pot, potOnchain: POT_ONCHAIN, playerStake: STAKE, houseStake: STAKE,
      playerPayoutPkScript: p2tr(0xa0), housePayoutPkScript: p2tr(0xb0), exitDelay: 86_528n, feeSats: BigInt(FEE),
    })
    tx.updateInput(0, { witnessUtxo: { script: pot.pkScript, amount: BigInt(POT_ONCHAIN.value) + 10_000n } })
    await expect(server.handleV4CooperativeExit('g1', {
      exitTxPsbt: base64.encode(tx.toPSBT()), potOnchain: POT_ONCHAIN, feeSats: FEE,
    }, deps)).rejects.toThrow(/witnessUtxo mismatch/)
  })

  it('REFUSES a tx that swaps in a different covenant leaf', async () => {
    // Same outpoint/sequence/witnessUtxo/outputs, but the input satisfies the
    // refund leaf (cooperativeSpend) instead of leaf 7 (cooperativeSpendExit).
    // The house co-sign commits to the tapleaf hash, so it must refuse.
    const { deps, pot } = await fixture()
    const { tx } = buildCooperativeSpendExitTx({
      pot, potOnchain: POT_ONCHAIN, playerStake: STAKE, houseStake: STAKE,
      playerPayoutPkScript: p2tr(0xa0), housePayoutPkScript: p2tr(0xb0), exitDelay: 86_528n, feeSats: BigInt(FEE),
    })
    tx.updateInput(0, { tapLeafScript: [pot.cooperativeSpend()] })
    await expect(server.handleV4CooperativeExit('g1', {
      exitTxPsbt: base64.encode(tx.toPSBT()), potOnchain: POT_ONCHAIN, feeSats: FEE,
    }, deps)).rejects.toThrow(/tapLeafScript mismatch/)
  })
})
