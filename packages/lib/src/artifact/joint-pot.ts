/**
 * v4 joint-pot contract, assembled from the artifact-JSON covenant model.
 *
 * This is the artifact-driven equivalent of `CoinflipJointPotScript`: every
 * covenant body comes from the declarative `asm`-token fragments in
 * `./covenants` (resolved through the SDK's `arkade.resolveAsm` — the same
 * encoder `arkade.contract()` uses), and each leaf is built from the SDK's
 * tapscript primitives + the arkade-script key tweak. The result is
 * byte-for-byte identical to the hand-rolled `CoinflipJointPotScript`
 * (locked down in `artifact-covenants.unit.test.ts`), so it is a drop-in:
 * same address, same 8 leaves, in-flight v4 games remain spendable.
 *
 * Leaf 6 (`playerForfeitExit`) is a hashlock+CSV conjunction that the stock
 * artifact `Program` cannot yet express (its tapscript segment allows at
 * most one of asm/csv/cltv). Per the v4 migration decision we keep it
 * byte-identical via the SDK's `ConditionCSVMultisigTapscript` primitive —
 * the single, isolated deviation from a pure `arkade.contract()`, to be
 * removed once ts-sdk PR #319's resolver gains asm+csv support.
 *
 * Leaf order (must match CoinflipJointPotScript for tree/address parity):
 *   0 playerWinCovenant  1 creatorWinCovenant  2 playerReveal
 *   3 cooperativeSpend    4 playerWinExit        5 creatorWinExit
 *   6 playerForfeitExit   7 cooperativeSpendExit
 */

import { OP } from '@scure/btc-signer'
import { hex } from '@scure/base'
import {
  VtxoScript,
  ConditionCSVMultisigTapscript,
  ConditionMultisigTapscript,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  MultisigTapscript,
  arkade,
} from '@arkade-os/sdk'
import { StageTwoScript } from '../joint-pot-stage2'
import type { CoinflipJointPotOptions } from '../joint-pot'
import { fullWinAsm, payToAsm, splitAsm } from './covenants'

// Local alias — the SDK's arkade-namespace type re-export changed in 0.4.41.
type ArkadeParamValue = Uint8Array | bigint | number

/** SHA256 hash-check (no trailing VERIFY — Condition* tapscripts append it). */
function buildHashCheckScript(hash: Uint8Array): Uint8Array {
  return new Uint8Array([OP.SHA256, 0x20, ...hash, OP.EQUAL])
}

/** The resolved arkade-script bodies of the v4 joint-pot covenant. */
export interface JointPotArkadeScripts {
  playerWinFull: Uint8Array
  creatorWinFull: Uint8Array
  forfeit: Uint8Array
  split: Uint8Array
  reveal: Uint8Array
}

/** An artifact-assembled v4 joint-pot contract. */
export interface JointPotArtifactContract {
  vtxoScript: VtxoScript
  /** The 8 committed leaf scripts (raw bytes), in leaf order 0..7. */
  scripts: Uint8Array[]
  /** Taproot output script (34-byte P2TR). */
  pkScript: Uint8Array
  /** The 8 committed leaf scripts, hex, in leaf order 0..7. */
  leafScriptsHex: string[]
  arkadeScripts: JointPotArkadeScripts
  /** The Phase-2 StageTwo contract the reveal covenant pays into. */
  stageTwo: StageTwoScript
}

/**
 * Assemble the v4 joint-pot contract from the artifact covenant fragments.
 * Byte-identical to `new CoinflipJointPotScript(opts)`.
 */
export function buildJointPotArtifactContract(
  opts: CoinflipJointPotOptions,
): JointPotArtifactContract {
  const {
    creatorPubkey,
    playerPubkey,
    serverPubkey,
    creatorHash,
    playerHash,
    finalExpiration,
    cancelDelay,
    exitDelay,
    oddsN,
    oddsTarget,
    oddsLo,
    emulatorPubkey,
    playerPayoutPkScript,
    housePayoutPkScript,
    playerStake,
    houseStake,
  } = opts
  const pot = playerStake + houseStake

  // Phase-2 StageTwo target for the reveal covenant (payTo(StageTwo, pot)).
  const stageTwo = new StageTwoScript({
    creatorPubkey,
    playerPubkey,
    serverPubkey,
    creatorHash,
    playerHash,
    finalExpiration,
    oddsN,
    oddsTarget,
    oddsLo,
    emulatorPubkey,
    playerPayoutPkScript,
    housePayoutPkScript,
    playerStake,
    houseStake,
  })

  // Contract-wide bind map for the artifact `$param` placeholders.
  const args: Record<string, ArkadeParamValue> = {
    creatorHash,
    playerHash,
    oddsN,
    oddsLo,
    oddsTarget,
    playerWp: playerPayoutPkScript.slice(2),
    houseWp: housePayoutPkScript.slice(2),
    stageTwoWp: stageTwo.pkScript.slice(2),
    pot,
    playerStake,
    houseStake,
  }

  // Covenant bodies — resolved from the declarative fragments (proven
  // byte-identical to the emulator-proven builders).
  const playerWinFull = arkade.resolveAsm(fullWinAsm(true, '$playerWp', '$pot'), args)
  const creatorWinFull = arkade.resolveAsm(fullWinAsm(false, '$houseWp', '$pot'), args)
  const forfeit = arkade.resolveAsm(payToAsm('$playerWp', '$pot'), args)
  const split = arkade.resolveAsm(
    splitAsm('$playerWp', '$playerStake', '$houseWp', '$houseStake'),
    args,
  )
  const reveal = arkade.resolveAsm(payToAsm('$stageTwoWp', '$pot'), args)

  const tweak = (script: Uint8Array): Uint8Array =>
    arkade.computeArkadeScriptPublicKey(emulatorPubkey, script)
  const csv = { value: exitDelay, type: 'seconds' as const }

  // 8 leaves, in the exact order CoinflipJointPotScript emits them.
  const scripts = [
    // 0 playerWinCovenant
    MultisigTapscript.encode({ pubkeys: [serverPubkey, tweak(playerWinFull)] }).script,
    // 1 creatorWinCovenant
    MultisigTapscript.encode({ pubkeys: [serverPubkey, tweak(creatorWinFull)] }).script,
    // 2 playerReveal (hashlock condition, no timelock)
    ConditionMultisigTapscript.encode({
      conditionScript: buildHashCheckScript(playerHash),
      pubkeys: [playerPubkey, serverPubkey, tweak(reveal)],
    }).script,
    // 3 cooperativeSpend (covenant-only refund-split, CLTV-gated)
    CLTVMultisigTapscript.encode({
      absoluteTimelock: cancelDelay,
      pubkeys: [serverPubkey, tweak(split)],
    }).script,
    // 4 playerWinExit
    CSVMultisigTapscript.encode({ timelock: csv, pubkeys: [playerPubkey, tweak(playerWinFull)] })
      .script,
    // 5 creatorWinExit
    CSVMultisigTapscript.encode({ timelock: csv, pubkeys: [creatorPubkey, tweak(creatorWinFull)] })
      .script,
    // 6 playerForfeitExit (hashlock + CSV conjunction — the one isolated
    //   ConditionCSV primitive; see module header).
    ConditionCSVMultisigTapscript.encode({
      conditionScript: buildHashCheckScript(playerHash),
      timelock: csv,
      pubkeys: [playerPubkey, tweak(forfeit)],
    }).script,
    // 7 cooperativeSpendExit (pure timelock, no covenant)
    CSVMultisigTapscript.encode({ timelock: csv, pubkeys: [playerPubkey, creatorPubkey] }).script,
  ]

  const vtxoScript = new VtxoScript(scripts)
  return {
    vtxoScript,
    scripts,
    pkScript: vtxoScript.pkScript,
    leafScriptsHex: scripts.map((s) => hex.encode(s)),
    arkadeScripts: { playerWinFull, creatorWinFull, forfeit, split, reveal },
    stageTwo,
  }
}
