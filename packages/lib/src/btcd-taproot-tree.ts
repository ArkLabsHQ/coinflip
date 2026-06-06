/**
 * btcd-compatible Taproot script tree builder.
 *
 * arkd's vtxo-script validator (`pkg/ark-lib/script/vtxo_script.go:226-244`)
 * calls btcd's `txscript.AssembleTaprootScriptTree(leaves...)` to derive the
 * taproot output key from the script set. btcd's algorithm is:
 *
 *   Phase 1 — pair leaves left-to-right:
 *     for i := 0; i < len(leaves); i += 2:
 *       if i is last (odd leaf at end):
 *         merge with the LAST branch built so far (not pair as a fresh leaf)
 *       else:
 *         create a new branch from (leaves[i], leaves[i+1])
 *
 *   Phase 2 — FIFO-queue merge branches:
 *     while branches has ≥ 2 items:
 *       take front two, combine into a new branch, push to back of queue
 *
 * scure-btc-signer's `taprootListToTree` instead builds a Huffman tree
 * (weight-1 leaves combine by smallest-weight pairs). For power-of-2 leaf
 * counts both algorithms happen to produce a perfectly balanced binary
 * tree and agree. For any other count they produce different shapes →
 * different merkle roots → different taproot output keys → arkd rejects
 * the spend with `INVALID_PSBT_INPUT: expected X, got Y`.
 *
 * This module reproduces btcd's algorithm in TS so we can build taptrees
 * that match arkd's expectations for arbitrary leaf counts.
 *
 * See: docs/superpowers/specs/2026-06-05-arkade-script-win-condition-design.md
 *      C:\Users\evilk\go\pkg\mod\github.com\btcsuite\btcd@v0.24.2\txscript\taproot.go:623
 */

import { TAP_LEAF_VERSION } from '@scure/btc-signer/payment.js'

/**
 * Internal tree node shape consumed by scure-btc-signer's `p2tr`:
 *   - A leaf is `{ script, leafVersion }`
 *   - A branch is a 2-element tuple `[leftNode, rightNode]`
 */
export interface TaprootLeaf {
  script: Uint8Array
  leafVersion: number
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TaprootTreeNode = TaprootLeaf | any[]

/**
 * Build a btcd-compatible Taproot script tree from a flat list of scripts.
 *
 * The returned structure is the nested-array form scure-btc-signer's
 * `p2tr(unspendable, tree, undefined, true)` accepts.
 */
export function assembleBtcdTaprootTree(scripts: Uint8Array[]): TaprootTreeNode {
  if (scripts.length === 0) {
    throw new Error('assembleBtcdTaprootTree: empty scripts list')
  }

  const leaves: TaprootLeaf[] = scripts.map((script) => ({
    script,
    leafVersion: TAP_LEAF_VERSION,
  }))

  if (leaves.length === 1) {
    return leaves[0]
  }

  // ── Phase 1: pair leaves left-to-right ─────────────────────────────────
  const branches: TaprootTreeNode[] = []
  for (let i = 0; i < leaves.length; i += 2) {
    if (i === leaves.length - 1) {
      // Odd leaf at end: merge into the LAST branch built so far.
      // Matches btcd's `branches[len(branches)-1] = NewTapBranch(branchToMerge, leaf)`.
      const last = branches.pop()
      if (last === undefined) {
        // Single leaf (handled above) or two-leaf input — defensive.
        throw new Error(
          `assembleBtcdTaprootTree: unexpected odd leaf at i=${i} with no prior branch`,
        )
      }
      branches.push([last, leaves[i]])
    } else {
      // Pair two consecutive leaves into a new branch.
      branches.push([leaves[i], leaves[i + 1]])
    }
  }

  // ── Phase 2: FIFO-queue merge branches ─────────────────────────────────
  // Take front two, combine, push to back. Stops when one branch remains.
  while (branches.length >= 2) {
    const left = branches.shift()!
    const right = branches.shift()!
    branches.push([left, right])
  }

  return branches[0]
}
