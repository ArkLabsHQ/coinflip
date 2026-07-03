/**
 * Coinflip v4 covenant bodies as artifact `asm`-token templates.
 *
 * These reproduce the emulator-proven covenant bytecode currently built by
 * `@arklabshq/contract-workflows-prototype` (`covenants.payTo` /
 * `buildSplitArkadeScript` / `buildForfeitArkadeScript`) and
 * `arkade-win.ts`, but expressed declaratively as the `asm` arrays that the
 * SDK's artifact model (`arkade.contract()` / `parseArtifact()`) consumes.
 * The SDK's `arkade.resolveAsm` substitutes `$param` placeholders and encodes
 * the tokens — so a body here + its `$params` reproduces the same bytes the
 * emulator already accepts (locked down byte-for-byte in
 * `artifact-covenants.unit.test.ts`).
 *
 * Placeholder convention: pass `'$name'` strings for values bound at
 * `arkade.contract(program, args)` time. Byte pushes (witness programs,
 * hashes) bind to `Uint8Array`; numeric pushes (amounts) bind to `bigint`.
 */

// `AsmToken` is a stable union; define it locally rather than depend on the SDK's
// arkade-namespace type re-export, whose shape changed in 0.4.41 (ts-sdk #319).
type AsmToken = string | number | bigint | Uint8Array

/**
 * `payTo(receiver, amount)` — assert the output at the witness-supplied index
 * pays exactly `amount` to the P2TR whose 32-byte witness program is `receiver`.
 *
 *   asm:     DUP INSPECTOUTPUTSCRIPTPUBKEY 1 EQUALVERIFY <receiver> EQUALVERIFY
 *            INSPECTOUTPUTVALUE <amount> EQUAL
 *   witness: [output_index]
 *
 * Mirrors `covenants.payTo` and the SDK HTLC test's `payTo` helper exactly.
 * `receiver`/`amount` are placeholder names (e.g. `'$playerWp'`, `'$pot'`).
 */
export function payToAsm(receiver: string, amount: string): AsmToken[] {
  return [
    'DUP',
    'INSPECTOUTPUTSCRIPTPUBKEY',
    1,
    'EQUALVERIFY',
    receiver,
    'EQUALVERIFY',
    'INSPECTOUTPUTVALUE',
    amount,
    'EQUAL',
  ]
}

/** Reveal packet types read via INSPECTPACKET (packets.REVEAL_*_PACKET_TYPE). */
const REVEAL_PLAYER_PACKET_TYPE = 16 // 0x10
const REVEAL_CREATOR_PACKET_TYPE = 17 // 0x11

/**
 * The variable-odds win predicate as an artifact `asm`-token template.
 *
 * A byte-for-byte mirror of `buildVariableOddsWinPredicate` (arkade-win.ts):
 * it reads the two reveal packets (INSPECTPACKET), verifies both SHA256
 * preimage commits, extracts each digit (LEFT/BIN2NUM), range-checks in
 * `[0, $oddsN)`, computes the roll `(dc + dp) mod $oddsN`, and decides
 * `$oddsLo <= roll < $oddsTarget` (player wins). `forPlayerWin=false`
 * appends NOT (creator-win leaf). Odds/hashes bind as `$oddsN`/`$oddsLo`/
 * `$oddsTarget`/`$creatorHash`/`$playerHash` at `arkade.contract(...)` time.
 *
 *   Exit stack: [..covenant args.., 1] if the named party wins, else fails/0.
 */
export function winPredicateAsm(forPlayerWin: boolean): AsmToken[] {
  const tokens: AsmToken[] = [
    // Phase 1: pull both reveal packets.
    REVEAL_PLAYER_PACKET_TYPE, 'INSPECTPACKET', 'VERIFY',
    REVEAL_CREATOR_PACKET_TYPE, 'INSPECTPACKET', 'VERIFY',
    // Phase 2: verify preimages.
    'DUP', 'SHA256', '$creatorHash', 'EQUALVERIFY',
    'SWAP', 'DUP', 'SHA256', '$playerHash', 'EQUALVERIFY',
    // Phase 3: extract numeric digits (first byte of each reveal).
    1, 'LEFT', 'BIN2NUM', 'SWAP', 1, 'LEFT', 'BIN2NUM',
    // Phase 4-6: range-check, roll, decide.
    'DUP', 0, '$oddsN', 'WITHIN', 'NOTIF',
    '2DROP', 1, // bad creator digit → player wins
    'ELSE',
    'SWAP', 'DUP', 0, '$oddsN', 'WITHIN', 'NOTIF',
    '2DROP', 0, // bad player digit → creator wins
    'ELSE',
    'ADD', '$oddsN', 'MOD', '$oddsLo', '$oddsTarget', 'WITHIN',
    'ENDIF',
    'ENDIF',
  ]
  // creator-win leaf inverts the player-win result.
  if (!forPlayerWin) tokens.push('NOT')
  return tokens
}

/**
 * Full win-covenant arkade-script: `<win-predicate> VERIFY <payTo winner>`.
 * Mirrors `playerWinFullArkadeScript` / `creatorWinFullArkadeScript`
 * (joint-pot.ts) — the emulator co-signs only when the named party wins AND
 * the whole pot is paid to `winner` at the witness-supplied output index.
 */
export function fullWinAsm(
  forPlayerWin: boolean,
  winner: string,
  amount: string,
): AsmToken[] {
  return [...winPredicateAsm(forPlayerWin), 'VERIFY', ...payToAsm(winner, amount)]
}

/**
 * Refund-split arkade-script: pay `houseAmount` to `houseWp` (VERIFY'd) AND
 * `playerAmount` to `playerWp`. Mirrors `buildSplitArkadeScript` — two payTo
 * bodies with the house check consumed by VERIFY so the player check is the
 * script's result.
 *
 *   witness: [playerOutputIndex, houseOutputIndex]  (house index on top)
 */
export function splitAsm(
  playerWp: string,
  playerAmount: string,
  houseWp: string,
  houseAmount: string,
): AsmToken[] {
  const houseBody = payToAsm(houseWp, houseAmount)
  return [
    ...houseBody.slice(0, -1), // drop the trailing EQUAL...
    'EQUALVERIFY', // ...and VERIFY it instead
    ...payToAsm(playerWp, playerAmount),
  ]
}
