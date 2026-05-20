/**
 * Auto-claim of coinflip-final fallback VTXOs.
 *
 * When a player exercises the trustless fallback — broadcasting the
 * pre-signed setup + final transactions out-of-band of the synchronous
 * /play + /sign happy path — a VTXO lands at the coinflip-final address.
 * This module consumes that VTXO on the house's behalf:
 *
 *   - creatorWin path : house won AND both secrets are known. Builds a
 *                       spend that uses the creatorWin leaf with both
 *                       secrets as the condition witness, signed by the
 *                       house (the "creator") + Ark server multisig.
 *   - abort path      : finalExpiration has elapsed without resolution.
 *                       Spends via the abort leaf, signed by the house +
 *                       Ark server multisig (no witness needed).
 *   - playerWin       : not auto-handled — the player+server multisig
 *                       leaf requires the player's signature, which the
 *                       house cannot provide. Logged for operator awareness.
 *
 * Disabled by default; enable via `COINFLIP_AUTO_CLAIM=1`. The reasoning
 * is risk: this code path is not exercised by the regtest e2e suite (which
 * only covers the happy path) and an incorrect spend tx may forfeit the
 * pot. The operator log emitted by `contract-manager.ts` is sufficient
 * for manual intervention until this path has live coverage.
 */

import { hex, base64 } from '@scure/base'
import {
  ArkAddress,
  ConditionWitness,
  CSVMultisigTapscript,
  Transaction,
  buildOffchainTx,
  decodeTapscript,
  setArkPsbtField,
  type ArkInfo,
  type ArkTxInput,
  type Contract,
  type ContractVtxo,
  type Identity,
  type Wallet,
} from '@arkade-os/sdk'
import { CoinflipFinalContractHandler } from 'arkade-coinflip'

import type { GameRow } from './repositories/types'

export type ClaimPath = 'creator-win' | 'abort'

function isAutoClaimEnabled(): boolean {
  return process.env.COINFLIP_AUTO_CLAIM === '1'
}

/**
 * Pick which leaf the house can spend a coinflip-final VTXO through, given
 * the contract record (source of truth for `finalExpiration`) and the game
 * row. Returns null when no house-signable path is available — e.g. player
 * won (handler picks playerWin, server can't sign), or the game is still
 * unresolved and the CLTV window hasn't elapsed.
 *
 * Exported for unit testing.
 */
export function decideClaimPath(contract: Contract, game: GameRow, nowSec = Math.floor(Date.now() / 1000)): ClaimPath | null {
  if (
    game.status === 'resolved' &&
    game.winner === 'house' &&
    game.house_secret_hex &&
    game.player_secret_hex
  ) {
    return 'creator-win'
  }
  const finalExp = Number(contract.params.finalExpiration)
  if (Number.isFinite(finalExp) && nowSec >= finalExp) {
    return 'abort'
  }
  return null
}

export interface AutoClaimDeps {
  wallet: Wallet
  identity: Identity
  arkInfo: ArkInfo
}

export interface AutoClaimResult {
  attempted: boolean
  path?: ClaimPath
  arkTxid?: string
  reason?: string
}

/**
 * Attempt to spend a freshly-arrived coinflip-final VTXO via creatorWin
 * or abort. Returns `{attempted: false, reason}` on every codepath that
 * doesn't actually submit a tx, so callers can log the decision.
 */
export async function attemptAutoClaim(
  contract: Contract,
  vtxos: ContractVtxo[],
  game: GameRow,
  deps: AutoClaimDeps,
): Promise<AutoClaimResult> {
  if (!isAutoClaimEnabled()) {
    return { attempted: false, reason: 'COINFLIP_AUTO_CLAIM not set' }
  }

  const path = decideClaimPath(contract, game)
  if (!path) {
    return { attempted: false, reason: `no house-signable path (status=${game.status}, winner=${game.winner ?? 'unresolved'})` }
  }

  if (vtxos.length === 0) {
    return { attempted: false, reason: 'no vtxos in event' }
  }

  // Source of truth for script params is the contract record. The handler's
  // `createScript` validates serialize/deserialize roundtrip — if params
  // are corrupt, this throws.
  const finalScript = CoinflipFinalContractHandler.createScript(contract.params)

  // Sanity: the contract's stored pkScript must match what the handler
  // re-derives from its params. ContractManager.createContract already
  // enforces this at write time, but re-check at spend time too.
  const expected = hex.encode(finalScript.pkScript)
  if (expected !== contract.script) {
    return {
      attempted: false,
      reason: `script mismatch: derived ${expected.substring(0, 16)}… vs contract ${contract.script.substring(0, 16)}…`,
    }
  }

  const leaf = path === 'creator-win' ? finalScript.creatorWin() : finalScript.abort()
  const tapTree = finalScript.encode()

  // Build offchain spend tx — one input (the new final VTXO), one output
  // to the house wallet. Fee model on this regtest is txFeeRate=0 and the
  // intent fee only applies to round intents, so don't deduct anything.
  const target = vtxos[0]
  const arkInput: ArkTxInput = {
    txid: target.txid,
    vout: target.vout,
    value: target.value,
    tapLeafScript: leaf,
    tapTree,
  }
  const houseArkAddress = await deps.wallet.getAddress()
  const houseDecoded = ArkAddress.decode(houseArkAddress)

  const serverUnrollScript = decodeTapscript(
    hex.decode(deps.arkInfo.checkpointTapscript),
  ) as CSVMultisigTapscript.Type

  const { arkTx, checkpoints } = buildOffchainTx(
    [arkInput],
    [{ script: houseDecoded.pkScript, amount: BigInt(target.value) }],
    serverUnrollScript,
  )

  // creatorWin needs the secrets as condition witness; abort needs nothing.
  if (path === 'creator-win') {
    setArkPsbtField(arkTx, 0, ConditionWitness, [
      hex.decode(game.house_secret_hex),
      hex.decode(game.player_secret_hex!),
    ])
  }

  const signed = await deps.identity.sign(arkTx, [0])

  const { arkTxid, signedCheckpointTxs } = await deps.wallet.arkProvider.submitTx(
    base64.encode(signed.toPSBT()),
    checkpoints.map((c) => base64.encode(c.toPSBT())),
  )

  const finalCheckpoints = await Promise.all(
    signedCheckpointTxs.map(async (c) => {
      const tx = Transaction.fromPSBT(base64.decode(c))
      const indices: number[] = []
      for (let i = 0; i < tx.inputsLength; i++) indices.push(i)
      const sc = await deps.identity.sign(tx, indices)
      return base64.encode(sc.toPSBT())
    }),
  )

  await deps.wallet.arkProvider.finalizeTx(arkTxid, finalCheckpoints)

  return { attempted: true, path, arkTxid }
}
