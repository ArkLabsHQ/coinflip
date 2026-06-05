/**
 * Coinflip win-condition arkade-script (v0.3).
 *
 * Replaces v0.2.x's `buildVariableOddsConditionScript` (Bitcoin Script,
 * digit-hidden-in-secret-length, manual mod-n) with an emulator-evaluated
 * arkade-script. The emulator runs this body before releasing its
 * cosignature; if the script fails, the win leaf is unspendable via the
 * covenant path.
 *
 * Reveals ride extension packets attached to the spending tx
 * (`OP_INSPECTPACKET`), not the tapscript witness stack. The witness
 * stack carries only the covenant args (`output_index`, `other_input_index`)
 * + the multisig sigs.
 *
 * See: docs/superpowers/specs/2026-06-05-arkade-script-win-condition-design.md
 *
 * Stack contract for `buildVariableOddsWinArkadeScript`:
 *
 *   Entry stack: [output_index, other_input_index]
 *                (covenant args — these will be consumed by the atomic-sweep
 *                 covenant prepended in the leaf wrapper. The win-predicate
 *                 leaves them untouched.)
 *
 *   Exit stack (forPlayerWin=true):
 *     [output_index, other_input_index, 1]  if PLAYER wins
 *     fails (OP_VERIFY/EQUALVERIFY) otherwise
 *
 *   Exit stack (forPlayerWin=false):
 *     [output_index, other_input_index, 1]  if CREATOR wins
 *     fails otherwise
 *
 *   The leaf wraps this with `OP_VERIFY` + the atomic-sweep covenant so
 *   the final script tail is: `winPredicate OP_VERIFY atomicSweep`.
 *
 * Body shape (after the OP_INSPECTPACKET / OP_VERIFY preamble):
 *   1. Pull packets:    `0x10 INSPECTPACKET VERIFY  0x11 INSPECTPACKET VERIFY`
 *   2. Verify preimages: `DUP SHA256 <cHash> EQUALVERIFY SWAP DUP SHA256 <pHash> EQUALVERIFY`
 *   3. Extract digits:  `1 LEFT BIN2NUM SWAP 1 LEFT BIN2NUM`
 *   4. Range-check + roll + decide:
 *        `DUP 0 <n> WITHIN NOTIF
 *           2DROP 1
 *         ELSE
 *           SWAP DUP 0 <n> WITHIN NOTIF
 *             2DROP 0
 *           ELSE
 *             ADD <n> MOD <lo> <target> WITHIN
 *           ENDIF
 *         ENDIF`
 *   5. For creatorWin leaf only: append `NOT`.
 *
 * Out-of-range invariant (per spec edge case #1):
 *   - bad creator → player wins (push 1)
 *   - bad player  → creator wins (push 0)
 *   - both bad    → outer NOTIF triggers first → player wins (push 1)
 *
 * Note on Bitcoin Script numeric semantics: `OP_BIN2NUM` reads a minimal
 * CScriptNum from a byte string; a single byte payload in [0x00..0x7f]
 * decodes as its own value. Byte 0x80 alone is the negative-zero
 * representation — undefined for our purposes — but every digit we use
 * is in [0, 256) where the spec caps n ≤ 256. With n ≤ 128 the digit
 * fits cleanly in a single byte; for n ∈ [129, 256] a digit byte with
 * the high bit set requires careful encoding. We keep n ≤ 128 in this
 * release (covers every realistic shape) and reject n > 128 at build
 * time to avoid the negative-CScriptNum trap; n > 128 is a future
 * extension that can pad the digit with a 0x00 high byte.
 */

import { sha256 } from '@scure/btc-signer/utils.js'
import { OP } from '@scure/btc-signer'
import { packets, covenants } from '@arklabshq/contract-workflows-prototype'

/** Arkade-extension opcodes (not in @scure/btc-signer's OP enum). */
const OP_INSPECTPACKET = 0xf4
const OP_BIN2NUM = 0xd8

/** Cap for v0.3 — see "Note on Bitcoin Script numeric semantics" above. */
const MAX_N = 128

/** A per-party digit commit. Live until reveal — never publish digit or salt. */
export interface DigitCommit {
  digit: number
  salt: Uint8Array
}

/** Generate a fresh commit for a digit in [0, n). 16-byte salt. */
export function commitDigit(digit: number, n: number): DigitCommit {
  if (!Number.isInteger(n) || n < 2 || n > MAX_N) {
    throw new Error(`commitDigit: n must be an integer in [2, ${MAX_N}], got ${n}`)
  }
  if (!Number.isInteger(digit) || digit < 0 || digit >= n) {
    throw new Error(`commitDigit: digit must be in [0, ${n}), got ${digit}`)
  }
  const salt = new Uint8Array(16)
  // Browser + Node 19+ both expose `crypto.getRandomValues` on globalThis.
  ;(globalThis as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto.getRandomValues(salt)
  return { digit, salt }
}

/** SHA256( [digit_byte] ‖ salt ). The committed-hash field in escrow params. */
export function digitHash(c: DigitCommit): Uint8Array {
  return sha256(packets.encodeReveal(c.digit, c.salt))
}

/**
 * Minimal numeric push, matching the encoding in `packages/lib/src/script.ts`:
 *   0       → OP_0
 *   1..16   → OP_1..OP_16
 *   17+     → minimal LE bytes with optional 0x00 sign-pad
 */
function pushNum(v: number): number[] {
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`pushNum: ${v} must be a non-negative integer`)
  }
  if (v === 0) return [0x00]
  if (v >= 1 && v <= 16) return [0x50 + v]
  const bytes: number[] = []
  let n = v
  while (n > 0) {
    bytes.push(n & 0xff)
    n >>= 8
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00)
  return [bytes.length, ...bytes]
}

/** Data push for a fixed-length byte string ≤ 75 bytes. */
function pushData(bytes: Uint8Array): number[] {
  if (bytes.length > 75) throw new Error('pushData: this helper only handles ≤ 75 bytes')
  return [bytes.length, ...bytes]
}

/**
 * Build ONLY the win-predicate fragment — useful for isolated testing.
 * For the full leaf script, use `buildVariableOddsWinArkadeScript` which
 * composes this predicate with the atomic-sweep covenant.
 *
 * Predicate-only stack contract:
 *   Entry: any stack (predicate is "additive" — it only pushes/manipulates
 *          values it itself pushed; covenant args at the bottom are not
 *          disturbed).
 *   Exit:  pushes a single 1/0 boolean indicating winner-match.
 */
export function buildVariableOddsWinPredicate(
  creatorHash: Uint8Array,
  playerHash: Uint8Array,
  n: number,
  target: number,
  lo: number,
  forPlayerWin: boolean,
): Uint8Array {
  if (creatorHash.length !== 32) throw new Error('creatorHash must be 32 bytes')
  if (playerHash.length !== 32) throw new Error('playerHash must be 32 bytes')
  if (!Number.isInteger(n) || n < 2 || n > MAX_N) {
    throw new Error(`invalid n: ${n} (must be 2..${MAX_N} in v0.3)`)
  }
  if (
    !Number.isInteger(lo) || !Number.isInteger(target) ||
    lo < 0 || target <= lo || target > n
  ) {
    throw new Error(
      `invalid odds range: need 0 <= lo < target <= n (got lo=${lo}, target=${target}, n=${n})`,
    )
  }

  return new Uint8Array([
    // ── Phase 1: pull both reveal packets ──────────────────────────────
    ...pushNum(packets.REVEAL_PLAYER_PACKET_TYPE),  // 0x10
    OP_INSPECTPACKET,                                // → pR, foundP
    OP.VERIFY,                                       // → pR
    ...pushNum(packets.REVEAL_CREATOR_PACKET_TYPE), // 0x11
    OP_INSPECTPACKET,                                // → pR, cR, foundC
    OP.VERIFY,                                       // → pR, cR

    // ── Phase 2: verify preimages ──────────────────────────────────────
    OP.DUP, OP.SHA256,
    ...pushData(creatorHash),
    OP.EQUALVERIFY,                                  // → pR, cR
    OP.SWAP,                                         // → cR, pR
    OP.DUP, OP.SHA256,
    ...pushData(playerHash),
    OP.EQUALVERIFY,                                  // → cR, pR

    // ── Phase 3: extract numeric digits ────────────────────────────────
    ...pushNum(1), OP.LEFT,
    OP_BIN2NUM,                                      // → cR, pDigit
    OP.SWAP,                                         // → pDigit, cR
    ...pushNum(1), OP.LEFT,
    OP_BIN2NUM,                                      // → pDigit, cDigit

    // ── Phase 4-6: range-check, roll, decide ──────────────────────────
    OP.DUP,
    ...pushNum(0), ...pushNum(n), OP.WITHIN,         // → pDigit, cDigit, cValid
    OP.NOTIF,
      OP['2DROP'],
      ...pushNum(1),                                 // bad creator → player wins
    OP.ELSE,
      OP.SWAP,
      OP.DUP,
      ...pushNum(0), ...pushNum(n), OP.WITHIN,       // → cDigit, pDigit, pValid
      OP.NOTIF,
        OP['2DROP'],
        ...pushNum(0),                               // bad player → creator wins
      OP.ELSE,
        OP.ADD,
        ...pushNum(n), OP.MOD,                       // → roll
        ...pushNum(lo), ...pushNum(target),
        OP.WITHIN,                                   // → playerWins
      OP.ENDIF,
    OP.ENDIF,

    // ── For creatorWin leaf: invert the predicate result ───────────────
    ...(forPlayerWin ? [] : [OP.NOT]),
  ])
}

/**
 * Build the win-condition arkade-script body.
 *
 * Composes: `<predicate> <OP_VERIFY> <atomicSweep covenant>` so the leaf's
 * full arkade-script atomically enforces (a) the winner is who the leaf
 * claims AND (b) the payout output structure of the spending tx.
 */
export function buildVariableOddsWinArkadeScript(
  creatorHash: Uint8Array,
  playerHash: Uint8Array,
  n: number,
  target: number,
  lo: number,
  forPlayerWin: boolean,
  payoutPkScript: Uint8Array,
  potAmount: bigint,
  otherStakeValue: bigint,
): Uint8Array {
  const predicate = buildVariableOddsWinPredicate(creatorHash, playerHash, n, target, lo, forPlayerWin)
  const covenant = covenants.atomicSweep(payoutPkScript, potAmount, otherStakeValue)
  return new Uint8Array([
    ...predicate,
    OP.VERIFY,
    ...covenant,
  ])
}
