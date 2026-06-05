/**
 * CoinflipEscrowScriptV3 — v0.3 per-funder escrow taptree.
 *
 * Same per-funder atomic-sweep design as v0.2.x, but:
 *   1. Win predicates move into arkade-script (`buildVariableOddsWinPredicate`,
 *      read reveals from extension packets via OP_INSPECTPACKET).
 *   2. The surrounding tapscript closure becomes plain Multisig (no
 *      ConditionMultisig — arkd's script interpreter no longer evaluates
 *      the win condition).
 *
 * 10-leaf taptree:
 *   1. playerWinCovenant       — Multisig[server, emu_tweaked(predicateP+covenant)]
 *   2. creatorWinCovenant      — Multisig[server, emu_tweaked(predicateC+covenant)]
 *   3. playerForfeit           — UNCHANGED from v2 (CLTV multisig)
 *   4. refund                  — UNCHANGED from v2 (per-funder CLTV multisig)
 *   5. playerWinExit           — CSVMultisig[player, emu_tweaked(predicateP+covenant)]
 *   6. creatorWinExit          — CSVMultisig[creator, emu_tweaked(predicateC+covenant)]
 *   7. playerForfeitExit       — UNCHANGED from v2 (ConditionCSVMultisig + hash-check)
 *   8. refundExit              — UNCHANGED from v2 (CSVMultisig[funder])
 *   9. cooperativeSpend (NEW)  — Multisig[player, creator, server]
 *  10. cooperativeSpendExit    — CSVMultisig[player, creator]
 *
 * IMPORTANT: arkd's `txscript.AssembleTaprootScriptTree` builds a different
 * tree shape than scure-btc-signer's `taprootListToTree` (Huffman) for
 * non-power-of-2 leaf counts. We override the parent VtxoScript's tap-tree
 * construction with `assembleBtcdTaprootTree`, which reproduces btcd's
 * algorithm so SDK and arkd agree on the merkle root + taproot output key
 * for any leaf count.
 *
 * See: docs/superpowers/specs/2026-06-05-arkade-script-win-condition-design.md
 */

import { OP, p2tr, TAPROOT_UNSPENDABLE_KEY } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { assembleBtcdTaprootTree } from './btcd-taproot-tree'
import {
  VtxoScript,
  ConditionCSVMultisigTapscript,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  MultisigTapscript,
  TapLeafScript,
  arkade,
} from '@arkade-os/sdk'
import { covenants } from '@arklabshq/contract-workflows-prototype'
import { buildForfeitArkadeScript } from './arkade-forfeit'
import { buildVariableOddsWinPredicate } from './arkade-win'
import type { ArkadeForfeitConfig } from './script'

export interface CoinflipEscrowOptionsV3 {
  creatorPubkey: Uint8Array
  playerPubkey: Uint8Array
  serverPubkey: Uint8Array
  creatorHash: Uint8Array
  playerHash: Uint8Array
  finalExpiration: bigint
  refundPubkey: Uint8Array
  exitDelay: bigint
  oddsN: number
  oddsTarget: number
  oddsLo: number
  arkadeForfeit: ArkadeForfeitConfig
}

/**
 * Build the SHA256 hash-check condition for the playerForfeitExit leaf.
 *
 * Same shape as v0.2.x's `buildHashCheckScript`: leave the EQUAL result on
 * the stack (no OP_VERIFY appended — the surrounding ConditionCSVMultisig
 * appends its own VERIFY).
 */
function buildHashCheckScript(hash: Uint8Array): Uint8Array {
  return new Uint8Array([
    OP.SHA256,
    0x20,
    ...hash,
    OP.EQUAL,
  ])
}

export class CoinflipEscrowScriptV3 extends VtxoScript {
  readonly playerWinCovenantScriptHex: string
  readonly creatorWinCovenantScriptHex: string
  readonly playerForfeitScriptHex: string
  readonly refundScriptHex: string
  readonly playerWinExitScriptHex: string
  readonly creatorWinExitScriptHex: string
  readonly playerForfeitExitScriptHex: string
  readonly refundExitScriptHex: string
  readonly cooperativeSpendScriptHex: string
  readonly cooperativeSpendExitScriptHex: string

  readonly playerWinFullArkadeScript: Uint8Array
  readonly creatorWinFullArkadeScript: Uint8Array
  readonly forfeitArkadeScript: Uint8Array

  constructor(readonly options: CoinflipEscrowOptionsV3) {
    const {
      creatorPubkey, playerPubkey, serverPubkey,
      creatorHash, playerHash, finalExpiration, refundPubkey, exitDelay,
      oddsN, oddsTarget, oddsLo,
      arkadeForfeit: { emulatorPubkey, playerPayoutPkScript, housePayoutPkScript, playerStake, houseStake },
    } = options

    const pot = playerStake + houseStake

    // Symmetric "other stake" derivation — same as v0.2.x.
    const isPlayerEscrow = hex.encode(refundPubkey) === hex.encode(playerPubkey)
    const otherStake = isPlayerEscrow ? houseStake : playerStake

    // ── Win-predicates (arkade-script — emu-evaluated) ──────────────────
    const playerWinPredicate = buildVariableOddsWinPredicate(
      creatorHash, playerHash, oddsN, oddsTarget, oddsLo, true,
    )
    const creatorWinPredicate = buildVariableOddsWinPredicate(
      creatorHash, playerHash, oddsN, oddsTarget, oddsLo, false,
    )

    // ── Atomic-sweep covenants (unchanged from v0.2.x) ──────────────────
    const playerPayoutCovenant = covenants.atomicSweep(playerPayoutPkScript, pot, otherStake)
    const creatorPayoutCovenant = covenants.atomicSweep(housePayoutPkScript, pot, otherStake)

    // ── Full arkade-script per win leaf: predicate + VERIFY + covenant ──
    const playerWinFullArkadeScript = new Uint8Array([
      ...playerWinPredicate,
      OP.VERIFY,
      ...playerPayoutCovenant,
    ])
    const creatorWinFullArkadeScript = new Uint8Array([
      ...creatorWinPredicate,
      OP.VERIFY,
      ...creatorPayoutCovenant,
    ])

    // Forfeit arkade-script — UNCHANGED from v2 (no predicate; covenant only).
    const forfeitArkadeScript = buildForfeitArkadeScript(playerPayoutPkScript, pot, otherStake)

    const tweakedEmuKey = (script: Uint8Array) =>
      arkade.computeArkadeScriptPublicKey(emulatorPubkey, script)

    // ── Leaves 1, 2 — plain multisig (predicate moved into arkade-script) ─
    const playerWinCovenantScript = MultisigTapscript.encode({
      pubkeys: [serverPubkey, tweakedEmuKey(playerWinFullArkadeScript)],
    }).script
    const creatorWinCovenantScript = MultisigTapscript.encode({
      pubkeys: [serverPubkey, tweakedEmuKey(creatorWinFullArkadeScript)],
    }).script

    // ── Leaves 3, 4 — UNCHANGED from v2 ────────────────────────────────
    const forfeitLeafScript = CLTVMultisigTapscript.encode({
      absoluteTimelock: finalExpiration,
      pubkeys: [playerPubkey, serverPubkey, tweakedEmuKey(forfeitArkadeScript)],
    }).script
    const refundTapscript = CLTVMultisigTapscript.encode({
      absoluteTimelock: finalExpiration,
      pubkeys: [refundPubkey, serverPubkey],
    })

    // ── Leaves 5, 6 — CSV-gated mirrors of 1, 2 (plain CSVMultisig) ─────
    const playerWinExitScript = CSVMultisigTapscript.encode({
      timelock: { value: exitDelay, type: 'seconds' },
      pubkeys: [playerPubkey, tweakedEmuKey(playerWinFullArkadeScript)],
    }).script
    const creatorWinExitScript = CSVMultisigTapscript.encode({
      timelock: { value: exitDelay, type: 'seconds' },
      pubkeys: [creatorPubkey, tweakedEmuKey(creatorWinFullArkadeScript)],
    }).script

    // ── Leaves 7, 8 — UNCHANGED from v2 ────────────────────────────────
    const playerForfeitExitScript = ConditionCSVMultisigTapscript.encode({
      conditionScript: buildHashCheckScript(playerHash),
      timelock: { value: exitDelay, type: 'seconds' },
      pubkeys: [playerPubkey, tweakedEmuKey(forfeitArkadeScript)],
    }).script
    const refundExitTapscript = CSVMultisigTapscript.encode({
      timelock: { value: exitDelay, type: 'seconds' },
      pubkeys: [refundPubkey],
    })

    // ── Leaves 9, 10 — cooperative spend + CSV mirror ──────────────────
    //
    // arkd's `vtxo_script.go:97-133` requires every Multisig/CLTVMultisig/
    // ConditionMultisig closure in the taptree to contain the arkd signer
    // pubkey. So `cooperativeSpend` includes serverPubkey as a passive
    // co-signer — arkd's signature is automatic for valid spends, so
    // player + creator can still cooperatively settle without the emulator.
    //
    // `cooperativeSpendExit` is a CSVMultisigClosure (ExitClosure, NOT
    // a ForfeitClosure), so it isn't checked for the signer pubkey and
    // stays a pure player+creator 2-of-2.
    const cooperativeSpendScript = MultisigTapscript.encode({
      pubkeys: [playerPubkey, creatorPubkey, serverPubkey],
    }).script
    const cooperativeSpendExitScript = CSVMultisigTapscript.encode({
      timelock: { value: exitDelay, type: 'seconds' },
      pubkeys: [playerPubkey, creatorPubkey],
    }).script

    // The full 10-leaf script set. The PSBT's `VtxoTaprootTree` field will
    // carry this script set in order, BUT — see post-super() block below —
    // we OVERRIDE the parent VtxoScript's tap-tree merkle-root derivation
    // with btcd's algorithm so that arkd agrees on the tap key.
    const scripts = [
      playerWinCovenantScript,        // 0
      creatorWinCovenantScript,       // 1
      forfeitLeafScript,              // 2
      refundTapscript.script,         // 3
      playerWinExitScript,            // 4
      creatorWinExitScript,           // 5
      playerForfeitExitScript,        // 6
      refundExitTapscript.script,     // 7
      cooperativeSpendScript,         // 8
      cooperativeSpendExitScript,     // 9
    ]
    super(scripts)

    // ── Replace parent's Huffman-built taptree state with btcd's tree ───
    //
    // The parent VtxoScript constructor (scure-btc-signer's `VtxoScript`)
    // builds the taptree via `taprootListToTree` (Huffman with equal
    // weights). For non-power-of-2 leaf counts the Huffman shape disagrees
    // with arkd's `txscript.AssembleTaprootScriptTree`, producing a
    // different tweakedPubkey + pkScript + per-leaf merkle proofs.
    //
    // We rebuild here using `assembleBtcdTaprootTree` (mirrors btcd's
    // algorithm exactly) and overwrite the parent fields. The parent
    // `this.scripts` (the flat script list used by `encode()`) is left
    // intact, so the encoded PSBT field matches what we built.
    const btcdTree = assembleBtcdTaprootTree(scripts)
    const btcdPayment = p2tr(TAPROOT_UNSPENDABLE_KEY, btcdTree, undefined, true)
    if (!btcdPayment.tapLeafScript || btcdPayment.tapLeafScript.length !== scripts.length) {
      throw new Error('CoinflipEscrowScriptV3: btcd taptree produced invalid leaves')
    }
    ;(this as { leaves: typeof btcdPayment.tapLeafScript }).leaves = btcdPayment.tapLeafScript
    ;(this as { tweakedPublicKey: Uint8Array }).tweakedPublicKey = btcdPayment.tweakedPubkey
    ;(this as { pkScript: Uint8Array }).pkScript = btcdPayment.script

    this.playerWinCovenantScriptHex = hex.encode(playerWinCovenantScript)
    this.creatorWinCovenantScriptHex = hex.encode(creatorWinCovenantScript)
    this.playerForfeitScriptHex = hex.encode(forfeitLeafScript)
    this.refundScriptHex = hex.encode(refundTapscript.script)
    this.playerWinExitScriptHex = hex.encode(playerWinExitScript)
    this.creatorWinExitScriptHex = hex.encode(creatorWinExitScript)
    this.playerForfeitExitScriptHex = hex.encode(playerForfeitExitScript)
    this.refundExitScriptHex = hex.encode(refundExitTapscript.script)
    this.cooperativeSpendScriptHex = hex.encode(cooperativeSpendScript)
    this.cooperativeSpendExitScriptHex = hex.encode(cooperativeSpendExitScript)
    this.playerWinFullArkadeScript = playerWinFullArkadeScript
    this.creatorWinFullArkadeScript = creatorWinFullArkadeScript
    this.forfeitArkadeScript = forfeitArkadeScript
  }

  playerWinCovenant(): TapLeafScript { return this.findLeaf(this.playerWinCovenantScriptHex) }
  creatorWinCovenant(): TapLeafScript { return this.findLeaf(this.creatorWinCovenantScriptHex) }
  playerForfeit(): TapLeafScript { return this.findLeaf(this.playerForfeitScriptHex) }
  refund(): TapLeafScript { return this.findLeaf(this.refundScriptHex) }
  playerWinExit(): TapLeafScript { return this.findLeaf(this.playerWinExitScriptHex) }
  creatorWinExit(): TapLeafScript { return this.findLeaf(this.creatorWinExitScriptHex) }
  playerForfeitExit(): TapLeafScript { return this.findLeaf(this.playerForfeitExitScriptHex) }
  refundExit(): TapLeafScript { return this.findLeaf(this.refundExitScriptHex) }
  cooperativeSpend(): TapLeafScript { return this.findLeaf(this.cooperativeSpendScriptHex) }
  cooperativeSpendExit(): TapLeafScript { return this.findLeaf(this.cooperativeSpendExitScriptHex) }

  /**
   * SDK contract-annotation helper — same role as v0.2.x's forfeit().
   * Coinflip's flow never goes through the wallet's forfeit path; this is
   * annotation bookkeeping. We surface the refund leaf as the closest
   * collaborative analog.
   */
  forfeit(): TapLeafScript {
    return this.findLeaf(this.refundScriptHex)
  }
}
