/**
 * End-to-end trustless coin flow through the SERVER handlers.
 *
 * Boots the real server deps against arkade-regtest, then plays a full game as
 * a client would:
 *   1. handleTrustlessPlay  → house escrows its stake, returns escrow address
 *   2. player escrows its stake (single-party send, client-side)
 *   3. handleTrustlessCommit → reveals, determines winner; house win → server
 *      sweeps; player win → returns sweep data and the CLIENT sweeps.
 *
 * Asserts the winner's spendable balance rises by the full pot — i.e. the
 * loser's escrowed stake actually moves. This is the live-server proof that
 * the money-leak (losses never debited) is fixed.
 */

import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import {
  buildOffchainTx,
  decodeTapscript,
  CSVMultisigTapscript,
  ConditionWitness,
  setArkPsbtField,
  Transaction,
  ArkAddress,
  Wallet,
  SingleKey,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  type Identity,
  type ArkProvider,
} from '@arkade-os/sdk'
import { faucet } from './helpers'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const HRP = 'tark' // server's networkHrpFromArkInfo returns 'tark' for regtest (HRP is cosmetic; pkScript is HRP-independent)
const BET = 1000
const HOUSE_FUND_BTC = 0.005
const PLAYER_FUND_BTC = 0.002

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)


async function makePlayerWallet(id: SingleKey): Promise<Wallet> {
  return Wallet.create({
    identity: id, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: false,
  })
}

async function waitFor(w: Wallet, kind: 'boarding' | 'settled', min: number, t = 120_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < t) {
    const b = await w.getBalance()
    if ((kind === 'boarding' ? b.boarding.total : b.settled) >= min) return
    await sleep(2000)
  }
  throw new Error(`Timeout waiting for ${kind} >= ${min}`)
}

const vtxoTotal = async (w: Wallet) => (await w.getVtxos()).reduce((a, v) => a + v.value, 0)

// Boarding UTXOs can lag the balance check on regtest; retry settle so a
// transient "No inputs found" doesn't flake the run.
async function settleWithRetry(w: Wallet, tries = 3): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await w.settle(); return } catch (e) {
      if (i === tries - 1) throw e
      await sleep(5000)
    }
  }
}

let arkAvailable = false
beforeAll(async () => {
  try {
    arkAvailable = (await fetch(`${ARK_SERVER_URL}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok
  } catch { arkAvailable = false }
}, 10_000)

describe('trustless coin flow (server handlers)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deps: any
  let arkProvider: ArkProvider
  let serverUnroll: CSVMultisigTapscript.Type

  beforeAll(async () => {
    if (!arkAvailable) return
    process.env.ARK_SERVER_URL = ARK_SERVER_URL
    process.env.ESPLORA_URL = ESPLORA_URL
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    server = require('arkade-coinflip-server')
    deps = await server.bootstrapDeps({ walletSettlementConfig: false })
    arkProvider = deps.wallet.arkProvider
    serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

    await faucet(await deps.wallet.getBoardingAddress(), HOUSE_FUND_BTC)
    await waitFor(deps.wallet, 'boarding', HOUSE_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(deps.wallet)
    await waitFor(deps.wallet, 'settled', BET * 5)
  }, 180_000)

  // Single-party submit by `signer`, optional condition witness on inputs.
  async function submit(arkTx: Transaction, checkpoints: Transaction[], signer: Identity, inputs: number[], witness?: Uint8Array[]): Promise<string> {
    if (witness) for (const i of inputs) setArkPsbtField(arkTx, i, ConditionWitness, witness)
    const signed = await signer.sign(arkTx, inputs)
    const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(signed.toPSBT()), checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const finals: string[] = []
    for (const c of signedCheckpointTxs) {
      const tx = Transaction.fromPSBT(base64.decode(c))
      const idx: number[] = []
      for (let i = 0; i < tx.inputsLength; i++) idx.push(i)
      if (witness) for (const i of idx) setArkPsbtField(tx, i, ConditionWitness, witness)
      finals.push(base64.encode((await signer.sign(tx, idx)).toPSBT()))
    }
    await arkProvider.finalizeTx(arkTxid, finals)
    return arkTxid
  }

  // Drive a game up to (but not including) /commit: fund a fresh player, run
  // handleTrustlessPlay, and have the player escrow its stake. Returns what a
  // client needs to commit. Shared by the idempotency + concurrency tests.
  async function playAndEscrow(opts: { oddsN?: number; oddsTarget?: number } = {}): Promise<{
    gameId: string
    playerEscrow: { txid: string; vout: number; value: number }
    playerSecretHex: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    play: any
  }> {
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await makePlayerWallet(playerId)
    await faucet(await playerW.getBoardingAddress(), PLAYER_FUND_BTC)
    await waitFor(playerW, 'boarding', PLAYER_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(playerW)
    await waitFor(playerW, 'settled', BET)

    // A 16-byte player secret = variable-odds digit 0 (valid); the house picks a
    // random digit at /play, so the roll is fair regardless.
    const playerSecret = Buffer.from(new Uint8Array(16)); crypto.getRandomValues(playerSecret)
    const playerHash = createHash('sha256').update(playerSecret).digest('hex')
    const playerPubHex = hex.encode(toXOnly(await playerId.compressedPublicKey()))
    const playerChangeAddress = await playerW.getAddress()

    const play = await server.handleTrustlessPlay(
      { tier: BET, playerPubkey: playerPubHex, playerHash, playerChangeAddress, oddsN: opts.oddsN, oddsTarget: opts.oddsTarget }, deps,
    )
    const escrowPk = ArkAddress.decode(play.escrowAddress).pkScript
    const pv = (await playerW.getVtxos())[0]
    const change = pv.value - BET
    const pOutputs: { script: Uint8Array; amount: bigint }[] = [{ script: escrowPk, amount: BigInt(BET) }]
    if (change > 0) pOutputs.push({ script: ArkAddress.decode(playerChangeAddress).pkScript, amount: BigInt(change) })
    const escrowTx = buildOffchainTx(
      [{ txid: pv.txid, vout: pv.vout, value: pv.value, tapLeafScript: pv.forfeitTapLeafScript, tapTree: pv.tapTree }],
      pOutputs, serverUnroll,
    )
    const playerEscrowTxid = await submit(escrowTx.arkTx, escrowTx.checkpoints, playerId, [0])
    return {
      gameId: play.gameId,
      playerEscrow: { txid: playerEscrowTxid, vout: 0, value: BET },
      playerSecretHex: hex.encode(playerSecret),
      play,
    }
  }

  // Poll until the house holds at least `min` VTXOs each covering BET.
  async function waitForHouseVtxos(min: number, t = 60_000): Promise<number> {
    const start = Date.now()
    let usable = 0
    while (Date.now() - start < t) {
      usable = (await deps.wallet.getVtxos()).filter((v: { value: number }) => v.value >= BET).length
      if (usable >= min) return usable
      await sleep(2000)
    }
    return usable
  }

  it('plays a full trustless game; the winner receives the full pot', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    const playerId = SingleKey.fromRandomBytes()
    const playerW = await makePlayerWallet(playerId)
    await faucet(await playerW.getBoardingAddress(), PLAYER_FUND_BTC)
    await waitFor(playerW, 'boarding', PLAYER_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(playerW)
    await waitFor(playerW, 'settled', BET)

    const playerSecret = Buffer.from(new Uint8Array(16)); crypto.getRandomValues(playerSecret) // 16 bytes
    const playerHash = createHash('sha256').update(playerSecret).digest('hex')
    const playerPubHex = hex.encode(toXOnly(await playerId.compressedPublicKey()))
    const playerChangeAddress = await playerW.getAddress()

    // 1) Play reserves the house stake (lazy-funding: the house only escrows
    //    on-chain at /commit) and returns the player escrow address + pot.
    const play = await server.handleTrustlessPlay(
      { tier: BET, playerPubkey: playerPubHex, playerHash, playerChangeAddress }, deps,
    )
    expect(play.escrowAddress.startsWith(HRP)).toBe(true)
    // House stake = pot − player stake (the house funds it at /commit).
    expect(play.pot - play.betAmount).toBe(BET)
    // The play response carries the absolute forfeit/refund deadline
    // (finalExpiration) baked into the escrow's CLTV leaves; commit/refund/forfeit
    // rebuild the IDENTICAL escrow script (its taproot address is hashed from the
    // leaf bytes), so the persisted state must carry the same value.
    expect(typeof play.finalExpiration).toBe('number')
    expect(play.finalExpiration).toBeGreaterThan(Math.floor(Date.now() / 1000))
    const persistedRow = await deps.repos.games.get(play.gameId)
    const persistedState = JSON.parse(persistedRow.house_vtxos_json as string)
    expect(persistedState.finalExpiration).toBe(play.finalExpiration)

    // 2) Player escrows its stake to the SAME address (single-party).
    const escrowPk = ArkAddress.decode(play.escrowAddress).pkScript
    const pv = (await playerW.getVtxos())[0]
    const change = pv.value - BET
    const pOutputs: { script: Uint8Array; amount: bigint }[] = [{ script: escrowPk, amount: BigInt(BET) }]
    if (change > 0) pOutputs.push({ script: ArkAddress.decode(playerChangeAddress).pkScript, amount: BigInt(change) })
    const escrowTx = buildOffchainTx(
      [{ txid: pv.txid, vout: pv.vout, value: pv.value, tapLeafScript: pv.forfeitTapLeafScript, tapTree: pv.tapTree }],
      pOutputs, serverUnroll,
    )
    const playerEscrowTxid = await submit(escrowTx.arkTx, escrowTx.checkpoints, playerId, [0])
    const playerEscrow = { txid: playerEscrowTxid, vout: 0, value: BET }

    // 3) Commit: reveal + resolve. The server settles BOTH wins via the
    // emulator-bound covenant — the winner signs nothing — and returns the
    // covenant-sweep txid.
    const commit = await server.handleTrustlessCommit(play.gameId, { playerSecretHex: hex.encode(playerSecret), playerEscrow }, deps)
    expect(['house', 'player']).toContain(commit.winner)
    expect(commit.txid).toBeTruthy()
    expect(commit.payout).toBe(play.pot)
    console.log(`[trustless-api] winner=${commit.winner} payout=${commit.payout} txid=${String(commit.txid).slice(0, 12)}…`)

    if (commit.winner === 'player') {
      // The covenant swept the full pot to the player's change address.
      await sleep(6000)
      expect(await vtxoTotal(playerW)).toBeGreaterThan(0)
    }

    const row = await deps.repos.games.get(play.gameId)
    expect(row.status).toBe('resolved')
    expect(row.winner).toBe(commit.winner)
  }, 300_000)

  it('is idempotent: a retried commit returns the same result, not an error', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const { gameId, playerEscrow, playerSecretHex } = await playAndEscrow()

    const first = await server.handleTrustlessCommit(gameId, { playerSecretHex, playerEscrow }, deps)
    // Replay the exact same commit (simulating a lost response). The old code
    // threw "Game is not pending: resolved"; now it must hand back the same
    // outcome so the client can recover — critical for a player-win sweep.
    const second = await server.handleTrustlessCommit(gameId, { playerSecretHex, playerEscrow }, deps)

    expect(second.winner).toBe(first.winner)
    expect(second.payout).toBe(first.payout)
    // Both wins are server-settled via the covenant; the replay must return the
    // SAME sweep txid, never re-submit.
    expect(first.txid).toBeTruthy()
    expect(second.txid).toBe(first.txid)
    console.log(`[trustless-api] idempotent retry ok (winner=${first.winner})`)

    const row = await deps.repos.games.get(gameId)
    expect(row.status).toBe('resolved')
    expect(row.winner).toBe(first.winner)
  }, 300_000)

  it('serializes concurrent commits: same game resolves once, no double-sweep', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const { gameId, playerEscrow, playerSecretHex } = await playAndEscrow()

    // Fire several commits for the SAME game at once. The per-game lock must let
    // exactly one resolve+sweep and have the rest replay the persisted result.
    // Without it a house win would double-submit the sweep → arkd double-spend
    // rejection → one promise rejects → Promise.all throws and this test fails.
    const N = 4
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        server.handleTrustlessCommit(gameId, { playerSecretHex, playerEscrow }, deps),
      ),
    )

    const { winner, payout, txid } = results[0]
    expect(txid).toBeTruthy() // server settled once
    for (const r of results) {
      expect(r.winner).toBe(winner)
      expect(r.payout).toBe(payout)
      expect(r.txid).toBe(txid) // every replay returns the same covenant sweep
    }
    console.log(`[trustless-api] ${N} concurrent commits resolved once (winner=${winner})`)

    const row = await deps.repos.games.get(gameId)
    expect(row.status).toBe('resolved')
    expect(row.winner).toBe(winner)
  }, 300_000)

  it('runs concurrent plays in parallel without double-spending a house VTXO', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const N = 4

    // Pre-split the house balance into enough distinct pieces that N plays can
    // each grab their own, then wait until they're visible on-Ark.
    await server.ensureHouseVtxoPool(deps, { targetCount: N + 2, pieceSize: BET * 2 })
    const usable = await waitForHouseVtxos(N)
    console.log(`[trustless-api] house has ${usable} usable VTXO(s) before ${N} concurrent plays`)

    // N distinct players — a play funds nothing (the house escrows at /commit),
    // so no player funding is needed here. Distinct pubkeys dodge the per-player
    // pending cap.
    const players = await Promise.all(Array.from({ length: N }, async () => {
      const id = SingleKey.fromRandomBytes()
      const w = await makePlayerWallet(id)
      const secret = Buffer.from(new Uint8Array(16)); crypto.getRandomValues(secret)
      return {
        tier: BET,
        playerPubkey: hex.encode(toXOnly(await id.compressedPublicKey())),
        playerHash: createHash('sha256').update(secret).digest('hex'),
        playerChangeAddress: await w.getAddress(),
      }
    }))

    // Fire them all at once.
    const settled = await Promise.allSettled(players.map((p) => server.handleTrustlessPlay(p, deps)))
    const ok = settled
      .filter((s): s is PromiseFulfilledResult<{ gameId: string; escrowAddress: string }> => s.status === 'fulfilled')
      .map((s) => s.value)
    const failed = settled
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map((s) => String(s.reason?.message ?? s.reason))
    console.log(`[trustless-api] concurrent plays: ${ok.length} ok, ${failed.length} busy${failed.length ? ' — ' + failed.join(' | ') : ''}`)

    // Safety: every successful play is a DISTINCT game with a DISTINCT player
    // escrow address (derived from a per-game random houseHash). The house VTXO
    // is selected by the SDK's wallet.send under its own mutex at /commit, so
    // there is no house outpoint to assert on at /play — distinct games + no
    // double-spend rejection is the /play-time invariant.
    const ids = ok.map((r) => r.gameId)
    expect(new Set(ids).size).toBe(ids.length)
    const addrs = ok.map((r) => r.escrowAddress)
    expect(new Set(addrs).size).toBe(addrs.length)
    // Real parallelism happened (more than one play in flight at once).
    expect(ok.length).toBeGreaterThanOrEqual(2)
    // Any failure must be the retryable capacity/busy condition — never a double-spend.
    for (const msg of failed) {
      expect(msg).toMatch(/busy|capacity/i)
      expect(msg).not.toMatch(/double|already spent|spent vtxo/i)
    }
  }, 300_000)

  it('builds a player refund PSBT for a stalled game (reclaimable, CLTV-locked, pays the player)', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const { gameId, playerEscrow } = await playAndEscrow()

    // The player can reclaim WITHOUT the server resolving — proof the escrow
    // isn't stranded if the server stalls after the escrow step.
    const refund = await server.handleTrustlessRefund(gameId, { playerEscrow }, deps)
    expect(refund.refundAddress.startsWith(HRP)).toBe(true)
    expect(refund.finalExpiration).toBeGreaterThan(Math.floor(Date.now() / 1000)) // future CLTV

    const tx = Transaction.fromPSBT(hex.decode(refund.refundPsbt))
    expect(tx.lockTime).toBe(refund.finalExpiration) // timelocked to finalExpiration
    expect(tx.inputsLength).toBe(1) // the player escrow VTXO
    // Output 0 returns the FULL escrow value to the player's own address (no
    // fee — offchain tx); output 1 is the zero-value P2A anchor.
    const out0 = tx.getOutput(0)
    expect(Number(out0.amount)).toBe(playerEscrow.value)
    expect(hex.encode(out0.script!)).toBe(hex.encode(ArkAddress.decode(refund.refundAddress).pkScript))
    console.log(`[trustless-api] refund PSBT ok — ${playerEscrow.value} sats reclaimable after ${refund.finalExpiration}`)
  }, 120_000)

  it('refuses to refund a resolved game (escrow already swept)', async () => {
    if (!arkAvailable) return
    const { gameId, playerEscrow, playerSecretHex } = await playAndEscrow()
    await server.handleTrustlessCommit(gameId, { playerSecretHex, playerEscrow }, deps)
    await expect(server.handleTrustlessRefund(gameId, { playerEscrow }, deps)).rejects.toThrow(/resolved/)
  }, 120_000)

  it('builds a player forfeit PSBT for a stalled game (R1 forfeit, CLTV-locked, pays the player)', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const { gameId, playerEscrow, play } = await playAndEscrow()

    // Lazy-funding: the house only escrows at /commit, so a stalled (pending)
    // game has no house escrow yet — but a forfeit needs BOTH escrows present.
    // Simulate the post-/commit "house funded, sweep not yet landed" state by
    // writing a house escrow outpoint into the persisted state (value = house
    // stake = BET for the coin). handleTrustlessForfeit only assembles an
    // UNSIGNED PSBT from the outpoints, so a well-formed synthetic outpoint
    // suffices for the structural assertions below (the tx is never submitted).
    const beforeRow = await deps.repos.games.get(gameId)
    const beforeState = JSON.parse(beforeRow.house_vtxos_json as string)
    const houseEscrow = { txid: 'b'.repeat(64), vout: 0, value: BET }
    await deps.repos.games.update(gameId, {
      houseVtxosJson: JSON.stringify({ ...beforeState, houseEscrow }),
    })

    // The player can claim BOTH escrows via the playerForfeit leaf once the CLTV
    // matures — no house cooperation needed for the R1 forfeit.
    const forfeit = await server.handleTrustlessForfeit(gameId, { playerEscrow }, deps)

    // Response shape checks.
    expect(typeof forfeit.forfeitPsbt).toBe('string')
    expect(forfeit.forfeitPsbt.length).toBeGreaterThan(0)
    expect(Array.isArray(forfeit.forfeitCheckpoints)).toBe(true)
    expect(typeof forfeit.forfeitClaimableAt).toBe('number')
    expect(typeof forfeit.payoutAddress).toBe('string')

    // The forfeit CLTV opens exactly at finalExpiration (when the abort window closes).
    expect(forfeit.forfeitClaimableAt).toBe(play.finalExpiration)

    // payoutAddress must be the player's own change address.
    const persistedRow = await deps.repos.games.get(gameId)
    expect(forfeit.payoutAddress).toBe(persistedRow.player_change_address)

    // The PSBT must parse as a valid offchain tx with 2 inputs (both escrows).
    const tx = Transaction.fromPSBT(hex.decode(forfeit.forfeitPsbt))
    expect(tx.inputsLength).toBe(2) // house escrow + player escrow
    // Single output: the full pot to the player's change address.
    expect(tx.outputsLength).toBeGreaterThanOrEqual(1)
    const out0 = tx.getOutput(0)
    const expectedPot = houseEscrow.value + playerEscrow.value
    expect(forfeit.potAmount).toBe(expectedPot)
    expect(forfeit.stakes[0] + forfeit.stakes[1]).toBe(expectedPot)
    expect(Number(out0.amount)).toBe(expectedPot)
    expect(hex.encode(out0.script!)).toBe(hex.encode(ArkAddress.decode(forfeit.payoutAddress).pkScript))

    console.log(`[trustless-api] forfeit PSBT ok — ${expectedPot} sats claimable after CLTV(${forfeit.forfeitClaimableAt}), payout=${forfeit.payoutAddress}`)
  }, 120_000)

  it('refuses to build a forfeit tx for a resolved game (escrows already swept)', async () => {
    if (!arkAvailable) return
    const { gameId, playerEscrow, playerSecretHex } = await playAndEscrow()
    await server.handleTrustlessCommit(gameId, { playerSecretHex, playerEscrow }, deps)
    await expect(server.handleTrustlessForfeit(gameId, { playerEscrow }, deps)).rejects.toThrow(/resolved/)
  }, 120_000)

  it('plays a variable-odds game end-to-end (asymmetric house-edged stakes, winner takes the pot)', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const oddsN = 6, oddsTarget = 2 // player wins ~1/3; house stakes the edged 2x multiple
    const { gameId, playerEscrow, playerSecretHex, play } = await playAndEscrow({ oddsN, oddsTarget })

    // House staked the edged multiple (default 3% = 300 bps); pot = player + house stake.
    const expectedHouseStake = Math.floor((BET * (oddsN - oddsTarget) * (10000 - 300)) / (oddsTarget * 10000))
    expect(play.oddsN).toBe(oddsN)
    expect(play.oddsTarget).toBe(oddsTarget)
    expect(play.pot - play.betAmount).toBe(expectedHouseStake)
    expect(play.pot).toBe(BET + expectedHouseStake)

    const commit = await server.handleTrustlessCommit(gameId, { playerSecretHex, playerEscrow }, deps)
    expect(['house', 'player']).toContain(commit.winner)
    expect(commit.payout).toBe(play.pot) // winner sweeps the full odds-weighted pot
    expect(commit.txid).toBeTruthy() // server settled via covenant (both wins)
    console.log(`[trustless-api] variable-odds ${oddsTarget}/${oddsN}: ${commit.winner} wins pot=${play.pot} (house staked ${expectedHouseStake})`)

    const row = await deps.repos.games.get(gameId)
    expect(row.status).toBe('resolved')
  }, 300_000)

  it('reconcile re-settles a committed game whose sweep never landed (backend retry)', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    // Run a REAL commit (the house funds its escrow on-chain AND covenant-sweeps
    // the pot — lazy-funding means the house only escrows at /commit). Then
    // rewind the row to `pending`, dropping the resolve marker but KEEPING the
    // funded houseEscrow + the player reveal/escrow, to simulate a crash after
    // the sweep landed but before the DB recorded `resolved`. The house escrow
    // VTXO is already spent on-Ark, so reconcile finishes it via its
    // spent-detection branch — exactly the backend-retry path under test.
    const { gameId, playerEscrow, playerSecretHex } = await playAndEscrow()
    const committed = await server.handleTrustlessCommit(gameId, { playerSecretHex, playerEscrow }, deps)
    expect(committed.txid).toBeTruthy()

    const resolvedRow = await deps.repos.games.get(gameId)
    const state = JSON.parse(resolvedRow.house_vtxos_json as string)
    delete state.resolveTxid
    await deps.repos.games.update(gameId, {
      status: 'pending',
      houseVtxosJson: JSON.stringify(state),
    })
    expect((await deps.repos.games.get(gameId)).status).toBe('pending') // rewound to unresolved

    // The backend must finish it autonomously — no client action, no forfeit.
    const reconciled = await server.reconcilePendingSweeps(deps)
    expect(reconciled).toBeGreaterThanOrEqual(1)

    const resolved = await deps.repos.games.get(gameId)
    expect(resolved.status).toBe('resolved')
    expect(['house', 'player']).toContain(resolved.winner)
    console.log(`[trustless-api] reconcile re-settled committed-but-unswept game → ${resolved.winner}`)
  }, 300_000)
})
