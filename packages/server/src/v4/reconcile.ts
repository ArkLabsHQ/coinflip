/**
 * v4 joint-pot game — the house's failsafe reconcile family.
 *
 *   - broadcastV4Refund / reconcileV4Refunds — split a never-revealed pot back to
 *     both funders past cancelDelay (the never-reveal griefing protection).
 *   - settleV4StageTwo / reconcileV4StageTwo — settle a CONTESTED game (player
 *     revealed on-chain, pot -> StageTwo) to the actual winner before the player's
 *     takeAll opens.
 *   - startV4RefundTimer — the periodic tick that runs the stage-2 settle first
 *     (a revealed pot can't be refunded) then the refund.
 */

import { base64, hex } from '@scure/base'
import { Transaction, decodeTapscript, CSVMultisigTapscript, RestIndexerProvider } from '@arkade-os/sdk'
import {
  determineWinnerV3, buildStageTwoSettleTx, buildJointPotRefundTx,
  encodeSettleForEmulator, getConditionWitness, type BuiltJointPotTx,
} from 'arkade-coinflip'
import { hashSecret, ARK_SERVER_URL } from '../house-wallet.js'
import { reservations } from '../vtxo-pool.js'
import { loadEmulatorConfig } from '../emulator.js'
import type { AppDeps } from '../deps.js'
import { withArkSubmit, revealLocks, sleep } from './concurrency.js'
import { rebuildCovenant, loadV4Game, listUnresolvedCofundedV4 } from './shared.js'
import type { V4State } from './types.js'

/**
 * Broadcast the REFUND for a co-funded game whose player never revealed — the
 * house's protection against the never-reveal griefing vector. Past cancelDelay
 * (enforced by arkd/emulator via the cooperativeSpend CLTV) this splits the pot
 * back: the player's stake to its payout, the house's to its payout — pre-empting
 * the player's later forfeit (finalExpiration > cancelDelay).
 *
 * COVENANT-ONLY: the emulator enforces the exact split (the splitTo arkade
 * script in buildJointPotRefundTx), so there is NO pre-signing — the house just
 * builds the tx and POSTs it, exactly like the settle. Idempotency: throws if the
 * pot was never co-funded or the game already settled.
 */
export async function broadcastV4Refund(gameId: string, deps: AppDeps): Promise<{ refundTxid: string }> {
  const { state, status } = await loadV4Game(deps, gameId)
  if (!state.cofundTxid) throw new Error('Cannot refund: pot not co-funded')
  if (status === 'resolved') throw new Error('Cannot refund: game already resolved')

  const pot = rebuildCovenant(state.covenant)
  const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
  const refund = buildJointPotRefundTx({
    pot,
    cofund: { txid: state.cofundTxid, vout: 0, value: state.pot },
    playerStake: BigInt(state.covenant.playerStake),
    houseStake: BigInt(state.covenant.houseStake),
    playerPayoutPkScript: hex.decode(state.covenant.playerPayoutPkScript),
    housePayoutPkScript: hex.decode(state.covenant.housePayoutPkScript),
    serverUnroll,
  })

  const cfg = await loadEmulatorConfig()
  if (!cfg) throw new Error('Emulator not configured')
  const body = JSON.stringify(encodeSettleForEmulator(refund))
  // The emulator co-signs the split covenant + forwards to arkd (each POST is an
  // arkd submit) — serialize it, retry transient lag. arkd enforces the CLTV, so
  // this only succeeds once the chain's MTP is past cancelDelay.
  const postOnce = async (): Promise<{ ok: true; txid: string } | { ok: false; status: number; text: string }> => {
    const r = await fetch(`${cfg.url}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(25_000) })
    if (r.ok) return { ok: true, txid: Transaction.fromPSBT(base64.decode((await r.json() as { signedArkTx: string }).signedArkTx)).id }
    return { ok: false, status: r.status, text: await r.text() }
  }
  let refundTxid = ''
  for (let a = 0; a < 10; a++) {
    const res = await withArkSubmit(postOnce)
    if (res.ok) { refundTxid = res.txid; break }
    const transient = res.status >= 500 && /not found|VTXO_NOT_FOUND|failed to process/i.test(res.text)
    if (!transient || a === 9) throw new Error(`Emulator rejected refund: ${res.status} ${res.text}`)
    await sleep(500 + a * 500)
  }

  reservations.release(gameId)
  await deps.repos.games.update(gameId, { status: 'resolved' })
  return { refundTxid }
}

/**
 * Failsafe reconcile — the house's AUTO-protection. For every co-funded v4 game
 * that's still unresolved and whose cancelDelay has passed (the player never
 * revealed), broadcast the refund to split the pot back — pre-empting the
 * player's later forfeit. Best-effort per game (one failure can't block the
 * rest). Returns the refund txids broadcast this pass.
 */
export async function reconcileV4Refunds(deps: AppDeps): Promise<string[]> {
  // Gate on the CHAIN tip time, not Date.now() — the cooperativeSpend CLTV is
  // enforced against the chain's median-time-past, so this matches what arkd will
  // accept (and the regtest mock-time the recovery e2e advances). Same source as
  // the v3 escrow recovery's CLTV gate.
  const chainTime = (await deps.wallet.onchainProvider.getChainTip()).time
  const stalled = await listUnresolvedCofundedV4(deps)
  const refundTxids: string[] = []
  for (const game of stalled) {
    let state: V4State
    try {
      state = JSON.parse(game.house_vtxos_json as string) as V4State
    } catch {
      continue
    }
    if (state.protocolVersion !== 'v4' || !state.cofundTxid) continue // not co-funded → nothing to refund
    if (chainTime <= state.covenant.cancelDelay) continue // CLTV not matured yet
    try {
      const { refundTxid } = await broadcastV4Refund(game.id, deps)
      console.log(`[v4-refund] reconciled stalled game ${game.id} → split-back ${refundTxid}`)
      refundTxids.push(refundTxid)
    } catch (e) {
      console.error(`[v4-refund] reconcile failed for ${game.id}:`, e instanceof Error ? e.message : e)
    }
  }
  return refundTxids
}

/**
 * Submit a built (covenant-only) joint-pot tx to the emulator (it co-signs +
 * forwards to arkd). Serialized via withArkSubmit + transient-retry, exactly like
 * the inline settle/refund posts. Returns the on-chain txid.
 */
async function submitBuiltToEmulator(built: BuiltJointPotTx, label: string): Promise<string> {
  const cfg = await loadEmulatorConfig()
  if (!cfg) throw new Error('Emulator not configured')
  const body = JSON.stringify(encodeSettleForEmulator(built))
  const postOnce = async (): Promise<{ ok: true; txid: string } | { ok: false; status: number; text: string }> => {
    const r = await fetch(`${cfg.url}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(25_000) })
    if (r.ok) return { ok: true, txid: Transaction.fromPSBT(base64.decode((await r.json() as { signedArkTx: string }).signedArkTx)).id }
    return { ok: false, status: r.status, text: await r.text() }
  }
  for (let a = 0; a < 10; a++) {
    const res = await withArkSubmit(postOnce)
    if (res.ok) return res.txid
    const transient = res.status >= 500 && /not found|VTXO_NOT_FOUND|failed to process/i.test(res.text)
    if (!transient || a === 9) throw new Error(`Emulator rejected ${label}: ${res.status} ${res.text}`)
    await sleep(500 + a * 500)
  }
  throw new Error(`Emulator ${label}: retries exhausted`)
}

/**
 * Extract the player's secret from the on-chain stage-1 reveal — the house's
 * defence when it never received /reveal (a losing player who skips it then sweeps
 * via takeAll). The preimage rides in the ConditionWitness PSBT field of one of
 * the StageTwo VTXO's ancestry txs; scan for the 17-byte element whose SHA256
 * equals the committed player hash. Returns undefined if not yet recoverable.
 */
async function extractPlayerSecretFromChain(indexer: RestIndexerProvider, stageTwoTxid: string, playerHashHex: string): Promise<Uint8Array | undefined> {
  const txids: string[] = [stageTwoTxid]
  try {
    const chain = await indexer.getVtxoChain({ txid: stageTwoTxid, vout: 0 })
    for (const c of chain.chain) if (!txids.includes(c.txid)) txids.push(c.txid)
  } catch { /* fall back to the StageTwo tx alone */ }
  for (const t of txids) {
    let raws: string[]
    try { raws = (await indexer.getVirtualTxs([t])).txs } catch { continue }
    for (const raw of raws) {
      let psbt: Transaction
      try { psbt = Transaction.fromPSBT(base64.decode(raw)) } catch { continue }
      for (let i = 0; i < psbt.inputsLength; i++) {
        const cw = getConditionWitness(psbt, i)
        if (cw) for (const el of cw) if (el.length === 17 && hashSecret(el) === playerHashHex) return el
      }
    }
  }
  return undefined
}

/**
 * Settle a CONTESTED game's StageTwo to the actual winner — the house's stage-2
 * response when a player revealed on-chain (pot -> StageTwo). The emulator
 * recomputes the winner from BOTH secrets, so the house can't cheat; settling
 * before finalExpiration pre-empts the player's takeAll. REQUIRED for fund-safety:
 * without it, a losing player who reveals on-chain would sweep the whole pot via
 * takeAll once finalExpiration passes.
 */
export async function settleV4StageTwo(gameId: string, deps: AppDeps): Promise<{ settleTxid: string; winner: 'player' | 'house' }> {
  // Serialize with handleV4Reveal on the SAME per-game lock so a /reveal and a
  // reconcile tick can't both drive a settle for one game concurrently.
  return revealLocks.runExclusive(gameId, () => settleV4StageTwoInner(gameId, deps))
}

async function settleV4StageTwoInner(gameId: string, deps: AppDeps): Promise<{ settleTxid: string; winner: 'player' | 'house' }> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error('Game not found')
  const state = JSON.parse(game.house_vtxos_json || '{}') as V4State
  if (state.protocolVersion !== 'v4') throw new Error('Not a v4 game')
  if (!state.cofundTxid) throw new Error('Pot not co-funded')
  if (game.status === 'resolved') throw new Error('Game already resolved')

  const pot = rebuildCovenant(state.covenant)
  const indexer = new RestIndexerProvider(ARK_SERVER_URL)
  const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(pot.stageTwo.pkScript)] })
  const hit = vtxos.find((v) => v.value === state.pot && !v.isSpent)
  if (!hit) throw new Error('No spendable StageTwo VTXO — stage 1 not revealed, or the contest already concluded')
  const stageTwoOutpoint = { txid: hit.txid, vout: hit.vout, value: hit.value }

  // The player's secret: stored if /reveal reached us (fast path), else extracted
  // from the on-chain stage-1 reveal (the house may never have received /reveal).
  let playerSecret = game.player_secret_hex ? hex.decode(game.player_secret_hex) : undefined
  if (!playerSecret) playerSecret = await extractPlayerSecretFromChain(indexer, hit.txid, game.player_hash)
  if (!playerSecret) throw new Error('Cannot settle StageTwo: player secret not yet recoverable from the chain')
  const houseSecret = hex.decode(game.house_secret_hex)

  const creatorReveal = { digit: houseSecret[0], salt: houseSecret.slice(1) }
  const playerReveal = { digit: playerSecret[0], salt: playerSecret.slice(1) }
  const outcome = determineWinnerV3(creatorReveal, playerReveal, state.oddsN, state.oddsTarget, state.oddsLo)
  const winnerPayoutPkScript = hex.decode(outcome === 'player' ? state.covenant.playerPayoutPkScript : state.covenant.housePayoutPkScript)
  const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

  const settle = buildStageTwoSettleTx({
    stageTwo: pot.stageTwo, stageTwoOutpoint,
    winner: outcome, winnerPayoutPkScript, potAmount: BigInt(state.pot),
    playerRevealBytes: playerSecret, creatorRevealBytes: houseSecret, serverUnroll,
  })
  const settleTxid = await submitBuiltToEmulator(settle, 'stage-2 settle')

  const winner: 'player' | 'house' = outcome === 'player' ? 'player' : 'house'
  reservations.release(gameId)
  await deps.repos.games.update(gameId, {
    status: 'resolved', winner, payoutAmount: state.pot, playerSecretHex: hex.encode(playerSecret),
  })
  return { settleTxid, winner }
}

/**
 * Failsafe reconcile — the house's AUTO stage-2 response. For every co-funded v4
 * game whose pot has been spent into its StageTwo covenant (a player revealed
 * on-chain), settle StageTwo to the actual winner. Runs BEFORE reconcileV4Refunds
 * each tick (a revealed pot can't be refunded). Best-effort per game. Returns the
 * settle txids broadcast this pass.
 */
export async function reconcileV4StageTwo(deps: AppDeps): Promise<string[]> {
  const cofunded = await listUnresolvedCofundedV4(deps)
  const indexer = new RestIndexerProvider(ARK_SERVER_URL)
  const settleTxids: string[] = []
  for (const game of cofunded) {
    let state: V4State
    try { state = JSON.parse(game.house_vtxos_json as string) as V4State } catch { continue }
    if (state.protocolVersion !== 'v4' || !state.cofundTxid) continue
    try {
      const pot = rebuildCovenant(state.covenant)
      const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(pot.stageTwo.pkScript)] })
      const live = vtxos.some((v) => v.value === state.pot && !v.isSpent)
      if (!live) {
        // A SPENT StageTwo on a STILL-pending game means WE never settled it (a
        // successful settleV4StageTwo would have marked it resolved with a winner) —
        // so the player swept the whole pot via takeAll because the house failed to
        // settle in time. Record it as a player win + ALARM: the house lost a
        // winnable contest, most likely because the emulator/arkd was unreachable
        // through finalExpiration. Mark resolved so we stop re-checking it every tick.
        // No StageTwo at all → not revealed; leave it for the refund.
        if (vtxos.some((v) => v.value === state.pot)) {
          console.warn(`[v4-stage2] game ${game.id}: StageTwo swept via takeAll before the house settled — house may have lost a winnable pot; check emulator/arkd liveness.`)
          reservations.release(game.id)
          await deps.repos.games.update(game.id, { status: 'resolved', winner: 'player', payoutAmount: state.pot })
        }
        continue
      }
      const { settleTxid, winner } = await settleV4StageTwo(game.id, deps)
      console.log(`[v4-stage2] settled contested game ${game.id} to ${winner} → ${settleTxid}`)
      settleTxids.push(settleTxid)
    } catch (e) {
      console.error(`[v4-stage2] reconcile failed for ${game.id}:`, e instanceof Error ? e.message : e)
    }
  }
  return settleTxids
}

/**
 * Periodic v4 reconcile (mirrors startEscrowRecoveryTimer's cadence). Each tick:
 * (1) settle CONTESTED games (pot revealed into StageTwo) to the winner, then
 * (2) refund never-revealed games past cancelDelay. Order matters — a revealed pot
 * can't be refunded, so stage-2 settle runs first.
 */
export function startV4RefundTimer(deps: AppDeps, intervalMs = 120_000): NodeJS.Timeout {
  // Re-entrancy guard: a tick's work (many stalled games × up-to-10 emulator
  // retries with backoff) can exceed the interval. Without this, ticks overlap
  // and two can attempt a refund/settle for the same game at once — wasted work
  // (arkd rejects the double-spend, and broadcastV4Refund isn't under revealLocks).
  let running = false
  const tick = async () => {
    if (running) {
      console.warn('[v4-reconcile] previous tick still running — skipping this interval')
      return
    }
    running = true
    try {
      const settled = await reconcileV4StageTwo(deps).catch((e) => {
        console.error('[v4-stage2] tick failed:', e instanceof Error ? e.message : e)
        return [] as string[]
      })
      if (settled.length > 0) console.log(`[v4-stage2] settled ${settled.length} contested game(s)`)
      const txids = await reconcileV4Refunds(deps).catch((e) => {
        console.error('[v4-refund] tick failed:', e instanceof Error ? e.message : e)
        return [] as string[]
      })
      if (txids.length > 0) console.log(`[v4-refund] reconciled ${txids.length} stalled game(s)`)
    } finally {
      running = false
    }
  }
  setTimeout(tick, 7_000)
  return setInterval(tick, intervalMs)
}
