/**
 * CoinflipEscrowScriptV3 — v0.3 per-funder escrow taptree.
 *
 * Same per-funder atomic-sweep design as v0.2.x, but:
 *   1. Win predicates move into arkade-script (`buildVariableOddsWinPredicate`,
 *      read reveals from extension packets via OP_INSPECTPACKET).
 *   2. The surrounding tapscript closure becomes plain Multisig (no
 *      ConditionMultisig — arkd's script interpreter no longer evaluates
 *      the win condition).
 *   3. Two new leaves added: `cooperativeSpend` (2-of-2 player+creator,
 *      no emu, no covenant, no clock) and `cooperativeSpendExit` (CSV mirror).
 *
 * Final taptree (10 leaves):
 *   1. playerWinCovenant       — Multisig[server, emu_tweaked(predicateP+covenant)]
 *   2. creatorWinCovenant      — Multisig[server, emu_tweaked(predicateC+covenant)]
 *   3. playerForfeit           — UNCHANGED from v2 (CLTV multisig)
 *   4. refund                  — UNCHANGED from v2 (per-funder CLTV multisig)
 *   5. playerWinExit           — CSVMultisig[player, emu_tweaked(predicateP+covenant)]
 *   6. creatorWinExit          — CSVMultisig[creator, emu_tweaked(predicateC+covenant)]
 *   7. playerForfeitExit       — UNCHANGED from v2 (ConditionCSVMultisig + hash-check)
 *   8. refundExit              — UNCHANGED from v2 (CSVMultisig[funder])
 *   9. cooperativeSpend (new)  — Multisig[player, creator]
 *  10. cooperativeSpendExit    — CSVMultisig[player, creator]
 *
 * See: docs/superpowers/specs/2026-06-05-arkade-script-win-condition-design.md
 */

import { OP } from '@scure/btc-signer'
import { hex } from '@scure/base'
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

    // ── Leaves 9, 10 — NEW: cooperative spend + CSV mirror ──────────────
    //
    // arkd validates that every MultisigClosure / CLTVMultisigClosure /
    // ConditionMultisigClosure leaf in the taptree contains the arkd signer
    // pubkey (see arkd's `pkg/ark-lib/script/vtxo_script.go:97-133`,
    // `Validate` → `ForfeitClosures()`). Without this, arkd rejects the whole
    // VTXO with "invalid forfeit closure, signer pubkey not found".
    //
    // Adding `serverPubkey` to the cooperative leaf doesn't change the
    // semantics: arkd's co-sig is automatic for valid spends, so player +
    // creator can still cooperatively settle whenever they agree — the server
    // is a passive co-signer, not a veto. This still lets the parties bypass
    // the emulator entirely (emu-offline recovery).
    //
    // CSV-mirror leaves are ExitClosures (`CSVMultisigClosure`) and are NOT
    // checked for the signer pubkey — so leaf 10 stays a pure player+creator
    // 2-of-2.
    const cooperativeSpendScript = MultisigTapscript.encode({
      pubkeys: [playerPubkey, creatorPubkey, serverPubkey],
    }).script
    const cooperativeSpendExitScript = CSVMultisigTapscript.encode({
      timelock: { value: exitDelay, type: 'seconds' },
      pubkeys: [playerPubkey, creatorPubkey],
    }).script

    super([
      playerWinCovenantScript,
      creatorWinCovenantScript,
      forfeitLeafScript,
      refundTapscript.script,
      playerWinExitScript,
      creatorWinExitScript,
      playerForfeitExitScript,
      refundExitTapscript.script,
      cooperativeSpendScript,
      cooperativeSpendExitScript,
    ])

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
