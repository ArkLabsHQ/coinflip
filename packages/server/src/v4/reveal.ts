/**
 * v4 joint-pot game — player-driven pot resolution (endpoint 4 + cooperative exit).
 *
 *   - handleV4Reveal — the player reveals its secret; the server determines the
 *     winner from both reveals and settles the WHOLE pot to the winner via the
 *     win-covenant leaf (lib buildJointPotSettleTx → emulator /v1/tx).
 *   - handleV4CooperativeExit — the emulator-free recovery path: the house co-signs
 *     the client's leaf-7 cooperativeSpendExit split-back (fail-closed).
 */

import { base64, hex } from '@scure/base'
import { Transaction, decodeTapscript, CSVMultisigTapscript } from '@arkade-os/sdk'
import {
  determineWinnerV3, computeRollV3, buildJointPotSettleTx,
  buildCooperativeSpendExitTx, encodeSettleForEmulator,
} from 'arkade-coinflip'
import { hashSecret } from '../house-wallet.js'
import { reservations } from '../vtxo-pool.js'
import { loadEmulatorConfig } from '../emulator.js'
import type { AppDeps } from '../deps.js'
import { withArkSubmit, revealLocks, sleep } from './concurrency.js'
import { rebuildCovenant } from './shared.js'
import type { V4State, V4RevealRequest, V4RevealResult, V4CooperativeExitRequest, V4CooperativeExitResult } from './types.js'

/** Fail-closed: the house co-signs ONLY a tx byte-shape-identical to the split-back
 *  it rebuilt (single input at the pot outpoint + CSV sequence, exact split outputs).
 *  Any deviation → refuse (never sign a tx that pays somewhere/something else). */
function assertSameExitShape(got: Transaction, want: Transaction): void {
  if (got.inputsLength !== 1 || got.outputsLength !== want.outputsLength) {
    throw new Error('cooperative-exit: tx shape mismatch')
  }
  const gi = got.getInput(0), wi = want.getInput(0)
  if (
    !gi.txid || !wi.txid || hex.encode(gi.txid) !== hex.encode(wi.txid) ||
    gi.index !== wi.index || gi.sequence !== wi.sequence
  ) {
    throw new Error('cooperative-exit: input outpoint/sequence mismatch — refusing to co-sign')
  }
  // The house signs input 0, so its taproot signature commits (via the sighash's
  // sha_amounts/sha_scriptpubkeys) to the spent output's amount + scriptPubKey,
  // and (via the tapleaf hash) to the leaf being satisfied. Pin both to `want`
  // so we only ever co-sign a spend of the real pot UTXO through the exact
  // cooperativeSpendExit leaf — never a substituted input value or leaf.
  if (
    !gi.witnessUtxo || !wi.witnessUtxo ||
    gi.witnessUtxo.amount !== wi.witnessUtxo.amount ||
    hex.encode(gi.witnessUtxo.script) !== hex.encode(wi.witnessUtxo.script)
  ) {
    throw new Error('cooperative-exit: input witnessUtxo mismatch — refusing to co-sign')
  }
  // btc-signer stores tapLeafScript as an array of [controlBlock, scriptBytes]
  // tuples; the script bytes (element [1]) are raw Bytes in both a freshly-built
  // and a deserialized PSBT, so compare those. The control block's merkle path is
  // derived from the taptree already pinned by witnessUtxo.script above, so the
  // script bytes are what fix which leaf is spent.
  const gl = gi.tapLeafScript ?? [], wl = wi.tapLeafScript ?? []
  if (wl.length === 0 || gl.length !== wl.length) {
    throw new Error('cooperative-exit: input tapLeafScript mismatch — refusing to co-sign')
  }
  for (let k = 0; k < wl.length; k++) {
    if (hex.encode(gl[k][1]) !== hex.encode(wl[k][1])) {
      throw new Error('cooperative-exit: input tapLeafScript mismatch — refusing to co-sign')
    }
  }
  for (let i = 0; i < want.outputsLength; i++) {
    const go = got.getOutput(i), wo = want.getOutput(i)
    if (go.amount !== wo.amount || !go.script || !wo.script || hex.encode(go.script) !== hex.encode(wo.script)) {
      throw new Error(`cooperative-exit: output ${i} mismatch — the house co-signs only the exact split-back`)
    }
  }
}

/**
 * POST /api/v4/game/:id/cooperative-exit — the HOUSE co-signs the client's leaf-7
 * `cooperativeSpendExit` split-back. The emulator-free recovery path: when the
 * emulator is unreachable after co-fund, the player unrolls the pot on-chain and
 * builds the split-back (leaf 7 = `CSVMultisig[player, creator]`, both must sign);
 * the house verifies the tx is EXACTLY the split-back it expects (fail-closed) and
 * adds its signature so the pot returns to both funders. The client broadcasts.
 */
export async function handleV4CooperativeExit(
  gameId: string,
  req: V4CooperativeExitRequest,
  deps: AppDeps,
): Promise<V4CooperativeExitResult> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error('Game not found')
  const state = JSON.parse(game.house_vtxos_json || '{}') as V4State
  if (state.protocolVersion !== 'v4' || !state.cofundTxid) {
    throw new Error('Not a co-funded v4 game — nothing to cooperatively exit')
  }
  // Terminal-state guard, matching the reveal-settle (handleV4RevealInner) and
  // refund (broadcastV4Refund) siblings: once the game is resolved the pot was
  // already spent (settled to the winner or split back), so there is nothing
  // left on-chain for the leaf-7 exit to claim — refuse rather than co-sign a
  // doomed double-spend.
  if (game.status === 'resolved') {
    throw new Error('Game already resolved — nothing to cooperatively exit')
  }
  const cv = state.covenant
  const pot = rebuildCovenant(cv)
  const { tx: expected } = buildCooperativeSpendExitTx({
    pot,
    potOnchain: { txid: req.potOnchain.txid, vout: req.potOnchain.vout, value: req.potOnchain.value },
    playerStake: BigInt(cv.playerStake),
    houseStake: BigInt(cv.houseStake),
    playerPayoutPkScript: hex.decode(cv.playerPayoutPkScript),
    housePayoutPkScript: hex.decode(cv.housePayoutPkScript),
    exitDelay: BigInt(cv.exitDelay),
    feeSats: BigInt(req.feeSats),
  })
  const clientTx = Transaction.fromPSBT(base64.decode(req.exitTxPsbt))
  assertSameExitShape(clientTx, expected)
  // Co-sign input 0 with the house (creator) key; the client already signed the player slot.
  const signed = await deps.identity.sign(clientTx, [0])
  return { exitTxPsbt: base64.encode(signed.toPSBT()) }
}

/**
 * POST /api/v4/game/:id/reveal — the player reveals its secret. The server
 * determines the winner from both reveals, settles the WHOLE pot to the winner
 * via the win-covenant leaf (lib buildJointPotSettleTx → emulator /v1/tx), and
 * marks the game resolved.
 */
export async function handleV4Reveal(gameId: string, req: V4RevealRequest, deps: AppDeps): Promise<V4RevealResult> {
  return revealLocks.runExclusive(gameId, () => handleV4RevealInner(gameId, req, deps))
}

async function handleV4RevealInner(gameId: string, req: V4RevealRequest, deps: AppDeps): Promise<V4RevealResult> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error('Game not found')
  const state = JSON.parse(game.house_vtxos_json || '{}') as V4State
  if (state.protocolVersion !== 'v4') throw new Error('Not a v4 game')
  if (!state.cofundTxid) throw new Error('Pot not co-funded yet (finalize the co-fund first)')
  if (game.status === 'resolved') throw new Error('Game already resolved')

  const playerSecret = hex.decode(req.playerSecretHex)
  if (hashSecret(playerSecret) !== game.player_hash) {
    throw new Error('Player secret does not match the committed hash')
  }
  const houseSecret = hex.decode(game.house_secret_hex)

  // First byte of each reveal is the digit (packets.encodeReveal: `[digit] || salt`).
  const creatorReveal = { digit: houseSecret[0], salt: houseSecret.slice(1) }
  const playerReveal = { digit: playerSecret[0], salt: playerSecret.slice(1) }
  const outcome = determineWinnerV3(creatorReveal, playerReveal, state.oddsN, state.oddsTarget, state.oddsLo)
  const roll = computeRollV3(creatorReveal, playerReveal, state.oddsN)

  const pot = rebuildCovenant(state.covenant)
  const winnerPayoutPkScript = hex.decode(outcome === 'player' ? state.covenant.playerPayoutPkScript : state.covenant.housePayoutPkScript)
  const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
  const settle = buildJointPotSettleTx({
    pot, cofund: { txid: state.cofundTxid, vout: 0, value: state.pot },
    winner: outcome, winnerPayoutPkScript, potAmount: BigInt(state.pot),
    playerRevealBytes: playerSecret, creatorRevealBytes: houseSecret, serverUnroll,
  })

  const cfg = await loadEmulatorConfig()
  if (!cfg) throw new Error('Emulator not configured')
  const body = JSON.stringify(encodeSettleForEmulator(settle))
  // The emulator forwards the finalized settle to arkd, so each POST is an arkd
  // submit — serialize it (backoff outside the lock), retry transient lag.
  const postOnce = async (): Promise<{ ok: true; txid: string } | { ok: false; status: number; text: string }> => {
    const r = await fetch(`${cfg.url}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(25_000) })
    if (r.ok) return { ok: true, txid: Transaction.fromPSBT(base64.decode((await r.json() as { signedArkTx: string }).signedArkTx)).id }
    return { ok: false, status: r.status, text: await r.text() }
  }
  let settleTxid = ''
  for (let a = 0; a < 10; a++) {
    const res = await withArkSubmit(postOnce)
    if (res.ok) { settleTxid = res.txid; break }
    const transient = res.status >= 500 && /not found|VTXO_NOT_FOUND|failed to process/i.test(res.text)
    if (!transient || a === 9) throw new Error(`Emulator rejected settle: ${res.status} ${res.text}`)
    await sleep(500 + a * 500)
  }

  const winner: 'player' | 'house' = outcome === 'player' ? 'player' : 'house'
  reservations.release(gameId)
  await deps.repos.games.update(gameId, {
    status: 'resolved',
    winner,
    payoutAmount: state.pot,
    playerSecretHex: req.playerSecretHex,
  })

  return { winner, settleTxid, payout: state.pot, houseSecretHex: game.house_secret_hex, roll }
}
