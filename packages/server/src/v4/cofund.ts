/**
 * v4 joint-pot game — the co-fund handshake (endpoints 2-3).
 *
 * The client signs the co-fund arkTx's player inputs; the server validates the tx,
 * signs the house inputs, submits, signs the house checkpoints, and returns the
 * player checkpoints for the client to sign in the finalize step, which creates the
 * joint-pot VTXO.
 */

import { base64, hex } from '@scure/base'
import { ArkAddress, Transaction } from '@arkade-os/sdk'
import { splitCheckpointsByOutpoint } from 'arkade-coinflip'
import { leafPubkeys } from '../checkpoint-diagnostics.js'
import { timeoutReject, ARK_SUBMIT_TIMEOUT_MS } from '../async-timeout.js'
import type { AppDeps } from '../deps.js'
import { withArkSubmit, cofundLocks } from './concurrency.js'
import { loadV4Game, toXOnly } from './shared.js'
import type { V4CofundRequest, V4CofundResult, V4CofundFinalizeRequest, V4CofundFinalizeResult } from './types.js'

/**
 * POST /api/v4/game/:id/cofund — the client has signed the co-fund arkTx's
 * player inputs (the leading k vins). The server validates the tx, signs the
 * house inputs (the trailing m vins), submits, signs the house checkpoints, and
 * returns the player checkpoints for the client to sign in the finalize step.
 */
export async function handleV4Cofund(gameId: string, req: V4CofundRequest, deps: AppDeps): Promise<V4CofundResult> {
  return cofundLocks.runExclusive(gameId, () => handleV4CofundInner(gameId, req, deps))
}

async function handleV4CofundInner(gameId: string, req: V4CofundRequest, deps: AppDeps): Promise<V4CofundResult> {
  const { state, status } = await loadV4Game(deps, gameId)
  if (status !== 'pending') throw new Error('Game is not pending')
  if (state.cofundArkTxid) throw new Error('Co-fund already submitted')

  const m = state.houseInputs.length
  const arkTx = Transaction.fromPSBT(base64.decode(req.arkTx))
  const total = arkTx.inputsLength
  const k = total - m // player inputs occupy the leading k vins, house the trailing m
  if (k < 1) throw new Error(`Co-fund must include at least one player input (got ${total} inputs for ${m} house inputs)`)
  if (req.checkpoints.length !== total) throw new Error(`Co-fund must have ${total} checkpoints (got ${req.checkpoints.length})`)

  // Guard 0: each of the trailing m house checkpoints must spend EXACTLY the
  // reserved house outpoint, in order. The arkTx's trailing vins reference these
  // checkpoints (Ark's checkpoint indirection — the vins are NOT the VTXO
  // outpoints), so the checkpoint's spent VTXO is where we confirm the house
  // signs only its reserved inputs. Guard 2 checks the contribution against the
  // persisted state, not the tx, so without this a client could place other
  // inputs at the trailing positions and have the house blindly sign them.
  for (let i = 0; i < m; i++) {
    const cp = Transaction.fromPSBT(base64.decode(req.checkpoints[k + i]))
    const cpIn = cp.getInput(0)
    const expected = state.houseInputs[i]
    const cpTxid = cpIn?.txid ? hex.encode(cpIn.txid) : ''
    if (cp.inputsLength !== 1 || cpTxid !== expected.txid || cpIn?.index !== expected.vout) {
      throw new Error(`Co-fund house checkpoint ${k + i} does not spend the reserved house input ${expected.txid}:${expected.vout}`)
    }
  }

  // Guard 1: output 0 is the agreed pot — exact amount to the covenant script.
  const potOut = arkTx.getOutput(0)
  const potPkScript = ArkAddress.decode(state.potAddress).pkScript
  if (!potOut || potOut.amount !== BigInt(state.pot) || !potOut.script || hex.encode(potOut.script) !== hex.encode(potPkScript)) {
    throw new Error('Co-fund output 0 does not match the agreed pot (amount or script mismatch)')
  }
  // Guard 2: the house contributes EXACTLY houseStake (no more). Its reserved
  // inputs sum to Hsum and its change returns to housePayoutPkScript, so
  // Hsum − houseChange must equal houseStake (±dust, since sub-dust change is
  // dropped). Protects the house from a client-crafted co-fund that overdraws it.
  const dust = Number(deps.arkInfo.dust ?? 546n)
  const Hsum = state.houseInputs.reduce((s, h) => s + h.value, 0)
  let houseChange = 0
  for (let o = 1; o < arkTx.outputsLength; o++) {
    const out = arkTx.getOutput(o)
    if (out?.script && hex.encode(out.script) === state.covenant.housePayoutPkScript) houseChange += Number(out.amount)
  }
  const houseContribution = Hsum - houseChange
  if (houseContribution < state.houseStake || houseContribution > state.houseStake + dust) {
    throw new Error(`Co-fund house contribution ${houseContribution} outside [${state.houseStake}, ${state.houseStake + dust}] — refusing to sign`)
  }

  // Sign the house input vins (trailing m), submit (serialized), sign the house
  // checkpoints (trailing m), return the player checkpoints (leading k).
  const houseVins = Array.from({ length: m }, (_, i) => k + i)
  const signed = await deps.identity.sign(arkTx, houseVins)
  const { arkTxid, signedCheckpointTxs } = await withArkSubmit(() =>
    timeoutReject(
      deps.wallet.arkProvider.submitTx(base64.encode(signed.toPSBT()), req.checkpoints),
      ARK_SUBMIT_TIMEOUT_MS, 'arkd submitTx',
    ),
  )
  if (signedCheckpointTxs.length !== total) throw new Error(`Expected ${total} checkpoints back, got ${signedCheckpointTxs.length}`)
  // arkd returns the signed checkpoints in Go map-iteration order (randomized per
  // response), NOT the submitted vin order. So DEMUX by the outpoint each checkpoint
  // spends (invariant to the shuffle), never by array position — a positional split
  // hands the house the PLAYER's checkpoint ~12.5% of the time (the n=2 map swap), the
  // house key isn't in that leaf so nothing gets signed, and finalize then rejects the
  // unsigned checkpoint with INVALID_SIGNATURE. Same hex(txid):vout convention as Guard 0.
  const houseOutpoints = new Set(state.houseInputs.map((h) => `${h.txid}:${h.vout}`))
  const { houseCheckpoints, playerCheckpoints } = splitCheckpointsByOutpoint(signedCheckpointTxs, houseOutpoints)
  if (houseCheckpoints.length !== m) throw new Error(`Co-fund: matched ${houseCheckpoints.length} house checkpoints by outpoint, expected ${m}`)
  if (playerCheckpoints.length !== k) throw new Error(`Co-fund: matched ${playerCheckpoints.length} player checkpoints, expected ${k}`)
  const houseSignedCheckpoints: string[] = []
  for (const b64 of houseCheckpoints) {
    // The house's OWN checkpoint — its forfeit leaf carries the house key, so the sign
    // MUST add it. NO silent swallow: after an outpoint match, a "nothing signed" result
    // is a real bug (arkd or a mis-selected coin), so let it throw here rather than
    // surface as an opaque INVALID_SIGNATURE at finalize.
    const cp = Transaction.fromPSBT(base64.decode(b64))
    const cpSigned = await deps.identity.sign(cp, Array.from({ length: cp.inputsLength }, (_, j) => j))
    houseSignedCheckpoints.push(base64.encode(cpSigned.toPSBT()))
  }

  state.cofundArkTxid = arkTxid
  state.houseSignedCheckpoints = houseSignedCheckpoints
  state.playerInputCount = k
  await deps.repos.games.update(gameId, { houseVtxosJson: JSON.stringify(state) })

  return { arkTxid, playerCheckpoints }
}

/**
 * POST /api/v4/game/:id/cofund-finalize — the client has signed its checkpoints
 * (the leading k inputs). The server finalizes the co-fund (player checkpoints +
 * the house checkpoints it signed at /cofund), creating the joint-pot VTXO.
 */
export async function handleV4CofundFinalize(gameId: string, req: V4CofundFinalizeRequest, deps: AppDeps): Promise<V4CofundFinalizeResult> {
  const { state } = await loadV4Game(deps, gameId)
  if (!state.cofundArkTxid || !state.houseSignedCheckpoints) throw new Error('Co-fund not submitted yet (call /cofund first)')
  if (state.cofundTxid) throw new Error('Co-fund already finalized')
  // Reject a wrong number of player checkpoints early (forward-compat: skip for
  // games co-funded before playerInputCount was persisted).
  if (state.playerInputCount !== undefined && req.playerCheckpoints.length !== state.playerInputCount) {
    throw new Error(`Expected ${state.playerInputCount} player checkpoints, got ${req.playerCheckpoints.length}`)
  }

  // finalizeTx takes checkpoints in vin order: [player (leading k), house (trailing m)].
  const allCheckpoints = [...req.playerCheckpoints, ...state.houseSignedCheckpoints!]
  try {
    await withArkSubmit(() =>
      timeoutReject(
        deps.wallet.arkProvider.finalizeTx(state.cofundArkTxid!, allCheckpoints),
        ARK_SUBMIT_TIMEOUT_MS, 'arkd finalizeTx',
      ),
    )
  } catch (e) {
    // Log-only diagnostic (behaviour unchanged — the error is re-thrown): dump each
    // checkpoint's spend-leaf keys + which keys actually signed, next to the house/
    // server keys, so a finalize INVALID_SIGNATURE tells us WHOSE checkpoint sig arkd
    // found missing/invalid (the house is normally NOT a checkpoint signer).
    try {
      const houseKey = hex.encode(toXOnly(await deps.identity.compressedPublicKey()))
      const serverKey = hex.encode(toXOnly(hex.decode(deps.arkInfo.signerPubkey)))
      const k = req.playerCheckpoints.length
      const dump = allCheckpoints.map((b64, idx) => {
        const in0 = Transaction.fromPSBT(base64.decode(b64)).getInput(0) as {
          txid?: Uint8Array; index?: number
          tapLeafScript?: ReadonlyArray<readonly [unknown, Uint8Array]>
          tapScriptSig?: ReadonlyArray<readonly [{ pubKey: Uint8Array }, Uint8Array]>
        }
        const outpoint = in0.txid ? `${hex.encode(in0.txid)}:${in0.index}` : '?'
        const leafKeys = (in0.tapLeafScript ?? []).flatMap(([, s]) => leafPubkeys(s))
        const sigKeys = (in0.tapScriptSig ?? []).map(([kk]) => hex.encode(kk.pubKey))
        return `#${idx}(${idx < k ? 'player' : 'house'} ${outpoint}) leaf=[${leafKeys.join(',')}] signed=[${sigKeys.join(',')}]`
      }).join(' | ')
      console.error(`[v4/finalize] ${gameId} finalizeTx FAILED: ${e instanceof Error ? e.message : String(e)} :: houseKey=${houseKey} serverKey=${serverKey} :: ${dump}`)
    } catch (diagErr) {
      console.error(`[v4/finalize] ${gameId} finalizeTx failed; diag dump errored: ${diagErr instanceof Error ? diagErr.message : String(diagErr)}`)
    }
    throw e
  }
  state.cofundTxid = state.cofundArkTxid
  await deps.repos.games.update(gameId, { houseVtxosJson: JSON.stringify(state) })

  return { cofundTxid: state.cofundArkTxid, potOutpoint: { txid: state.cofundArkTxid, vout: 0, value: state.pot } }
}
