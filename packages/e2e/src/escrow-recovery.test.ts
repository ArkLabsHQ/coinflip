/**
 * House-escrow recovery e2e: a stalled (expired) trustless game leaves the
 * house's escrowed stake sitting at the escrow address. recoverOrphanedHouseEscrows
 * must reclaim it via the house escrow's refund leaf once finalExpiration matures —
 * the house-side counterpart to the player's client reclaim.
 *
 * We construct a game whose finalExpiration is already in the PAST (so the
 * refund CLTV is satisfiable now), escrow the house stake into the matching
 * house escrow script, persist it as an expired game (with the arkadeForfeit
 * pins recovery rebuilds from), then run recovery and assert the house balance
 * comes back. Also covers the gating (future-CLTV games are skipped) and
 * idempotency (a second pass is a no-op).
 *
 * Needs arkd (:7070) AND the emulator (:7073) — the covenant escrow pins the
 * emulator-tweaked key, so the script can't be built without it.
 */

import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getHouseEscrowScript, type Game } from 'arkade-coinflip'
import {
  buildOffchainTx, decodeTapscript, CSVMultisigTapscript, Transaction, ArkAddress, SingleKey,
  type ArkProvider, type Identity, type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { faucet } from './helpers'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMULATOR_URL = process.env.EMULATOR_URL || 'http://localhost:7073'
const HOUSE_FUND_BTC = 0.005
const BET = 1000
const EXIT_DELAY = 86528 // BIP68 seconds, multiple of 512

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
const p2tr = (xonly: Uint8Array) => new Uint8Array([0x51, 0x20, ...xonly]) // valid-shaped payout pkScript

async function waitForBoarding(w: { getBalance: () => Promise<{ boarding: { total: number } }> }, min: number, t = 30_000) {
  const start = Date.now()
  while (Date.now() - start < t) { if ((await w.getBalance()).boarding.total >= min) return; await sleep(2000) }
  throw new Error('Timeout waiting for boarding')
}
async function waitForSettled(w: { getBalance: () => Promise<{ settled: number }> }, min: number, t = 90_000) {
  const start = Date.now()
  while (Date.now() - start < t) { if ((await w.getBalance()).settled >= min) return; await sleep(2000) }
  throw new Error('Timeout waiting for settled')
}

let arkAvailable = false
beforeAll(async () => {
  try { arkAvailable = (await fetch(`${ARK_SERVER_URL}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok } catch { arkAvailable = false }
}, 10_000)

interface ArkadeForfeitHex {
  emulatorPubkeyHex: string
  playerPayoutPkScriptHex: string
  housePayoutPkScriptHex: string
  playerStake: number
  houseStake: number
  exitDelay: number
}

describe('house-escrow recovery for stalled games', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deps: any
  let arkProvider: ArkProvider
  let serverUnroll: CSVMultisigTapscript.Type
  let dataDir: string
  let emulatorPubkey: Uint8Array | null = null

  beforeAll(async () => {
    if (!arkAvailable) return
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinflip-recovery-test-'))
    process.env.DATA_DIR = dataDir
    process.env.ARK_SERVER_URL = ARK_SERVER_URL
    process.env.ESPLORA_URL = ESPLORA_URL
    process.env.EMULATOR_URL = EMULATOR_URL
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    server = require('arkade-coinflip-server')
    deps = await server.bootstrapDeps({ walletSettlementConfig: false })
    arkProvider = deps.wallet.arkProvider
    serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

    // The covenant escrow pins the emulator-tweaked key — fetch its pubkey.
    try {
      const info = (await (await fetch(`${EMULATOR_URL}/v1/info`)).json()) as { signerPubkey: string }
      emulatorPubkey = hex.decode(info.signerPubkey)
    } catch { emulatorPubkey = null }

    await faucet(await deps.wallet.getBoardingAddress(), HOUSE_FUND_BTC)
    await waitForBoarding(deps.wallet, HOUSE_FUND_BTC * 1e8 * 0.9)
    await deps.wallet.settle()
    await waitForSettled(deps.wallet, BET * 5)
  }, 180_000)

  afterAll(() => {
    if (dataDir && fs.existsSync(dataDir)) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  const ready = () => arkAvailable && emulatorPubkey !== null

  // Single-party submit by the house identity.
  async function submit(arkTx: Transaction, checkpoints: Transaction[], signInputs: number[]): Promise<string> {
    const signed = await (deps.identity as Identity).sign(arkTx, signInputs)
    const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(signed.toPSBT()), checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const finals: string[] = []
    for (const c of signedCheckpointTxs) {
      const tx = Transaction.fromPSBT(base64.decode(c))
      const idx = Array.from({ length: tx.inputsLength }, (_, i) => i)
      finals.push(base64.encode((await (deps.identity as Identity).sign(tx, idx)).toPSBT()))
    }
    await arkProvider.finalizeTx(arkTxid, finals)
    return arkTxid
  }

  // Build the Game exactly as the server's buildGame would (incl. the
  // arkadeForfeit covenant pins), for a chosen expiry. Returns the game plus the
  // persisted-state hex bundle so recovery rebuilds the IDENTICAL escrow.
  async function makeGame(finalExpiration: number, setupExpiration: number): Promise<{
    game: Game; houseSecret: Uint8Array; playerPubHex: string; playerHashHex: string; arkadeForfeitHex: ArkadeForfeitHex
  }> {
    const housePub = await (deps.identity as Identity).xOnlyPublicKey()
    const serverPub = toXOnly(hex.decode(deps.arkInfo.signerPubkey))
    const houseSecret = new Uint8Array(15); crypto.getRandomValues(houseSecret)
    const playerSecret = new Uint8Array(16); crypto.getRandomValues(playerSecret)
    const playerId = SingleKey.fromRandomBytes()
    const playerPub = toXOnly(await playerId.compressedPublicKey())
    const houseHash = sha(houseSecret)
    const playerHash = sha(playerSecret)
    const playerPayoutPkScript = p2tr(playerPub)
    const housePayoutPkScript = p2tr(housePub)
    const game: Game = {
      gameId: 'escrow',
      betAmount: BigInt(BET),
      serverPubkey: serverPub,
      setupExpiration,
      finalExpiration,
      creator: { pubkey: housePub, hash: houseHash },
      player: { pubkey: playerPub, hash: playerHash },
      // arkadeForfeit covenant config (required by the escrow script).
      emulatorPubkey: emulatorPubkey!,
      playerForfeitPkScript: playerPayoutPkScript,
      housePayoutPkScript,
      playerStake: BET,
      houseStake: BET,
      exitDelay: EXIT_DELAY,
    }
    const arkadeForfeitHex: ArkadeForfeitHex = {
      emulatorPubkeyHex: hex.encode(emulatorPubkey!),
      playerPayoutPkScriptHex: hex.encode(playerPayoutPkScript),
      housePayoutPkScriptHex: hex.encode(housePayoutPkScript),
      playerStake: BET,
      houseStake: BET,
      exitDelay: EXIT_DELAY,
    }
    return { game, houseSecret, playerPubHex: hex.encode(playerPub), playerHashHex: hex.encode(playerHash), arkadeForfeitHex }
  }

  // Escrow `amount` from the house wallet into `pkScript` (single-party).
  async function escrowHouseInto(pkScript: Uint8Array, amount: number): Promise<{ txid: string; vout: number; value: number }> {
    const v = (await deps.wallet.getVtxos()).find((x: ExtendedVirtualCoin) => x.value >= amount)
    if (!v) throw new Error('no house VTXO')
    const change = v.value - amount
    const outs: { script: Uint8Array; amount: bigint }[] = [{ script: pkScript, amount: BigInt(amount) }]
    if (change > 0) outs.push({ script: ArkAddress.decode(await deps.wallet.getAddress()).pkScript, amount: BigInt(change) })
    const { arkTx, checkpoints } = buildOffchainTx(
      [{ txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript, tapTree: v.tapTree }], outs, serverUnroll,
    )
    const txid = await submit(arkTx, checkpoints, [0])
    return { txid, vout: 0, value: amount }
  }

  async function persistExpiredGame(opts: { game: Game; houseSecret: Uint8Array; playerPubHex: string; playerHashHex: string; pkScriptHex: string; houseEscrow: object; arkadeForfeitHex: ArkadeForfeitHex }, repos = deps.repos): Promise<string> {
    const id = `recovery-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    await repos.games.save({
      id, tier: BET, playerPubkey: opts.playerPubHex, playerChoice: 'trustless', playerHash: opts.playerHashHex,
      houseSecretHex: hex.encode(opts.houseSecret), finalScriptHex: opts.pkScriptHex,
      houseVtxosJson: JSON.stringify({
        finalExpiration: opts.game.finalExpiration, setupExpiration: opts.game.setupExpiration,
        houseEscrow: opts.houseEscrow,
        arkadeForfeit: opts.arkadeForfeitHex,
      }),
    })
    await repos.games.update(id, { status: 'expired' })
    return id
  }

  const vtxoTotal = async (): Promise<number> => (await deps.wallet.getVtxos()).reduce((a: number, v: ExtendedVirtualCoin) => a + v.value, 0)

  it('reclaims an orphaned house escrow once the CLTV has matured', async () => {
    if (!ready()) { console.warn('ark/emulator unavailable — skipped'); return }
    const now = Math.floor(Date.now() / 1000)
    const { game, houseSecret, playerPubHex, playerHashHex, arkadeForfeitHex } = await makeGame(now - 3600, now - 7200) // past CLTV
    const houseEscrowScript = getHouseEscrowScript(game)
    const houseEscrow = await escrowHouseInto(houseEscrowScript.pkScript, BET)
    const gameId = await persistExpiredGame({ game, houseSecret, playerPubHex, playerHashHex, pkScriptHex: hex.encode(houseEscrowScript.pkScript), houseEscrow, arkadeForfeitHex })

    const before = await vtxoTotal()
    const recovered = await server.recoverOrphanedHouseEscrows(deps)
    expect(recovered).toBeGreaterThanOrEqual(1)
    await sleep(6000)
    const after = await vtxoTotal()
    console.log(`[recovery-test] house total ${before} -> ${after} (reclaimed ${recovered})`)
    expect(after - before).toBeGreaterThanOrEqual(BET - 100)

    const row = await deps.repos.games.get(gameId)
    const state = JSON.parse(row.house_vtxos_json)
    expect(state.houseRefundTxid).toBeTruthy()

    // Idempotent: a second pass must not re-refund (txid already recorded).
    const again = await server.recoverOrphanedHouseEscrows(deps)
    const stillSame = JSON.parse((await deps.repos.games.get(gameId)).house_vtxos_json).houseRefundTxid
    expect(stillSame).toBe(state.houseRefundTxid)
    expect(again).toBe(0)
  }, 300_000)

  it('skips a game whose refund CLTV has not matured yet', async () => {
    if (!ready()) return
    const now = Math.floor(Date.now() / 1000)
    const { game, houseSecret, playerPubHex, playerHashHex, arkadeForfeitHex } = await makeGame(now + 3600, now + 1800) // FUTURE CLTV
    const houseEscrowScript = getHouseEscrowScript(game)
    // No need to actually escrow — recovery skips on the CLTV gate before building.
    const gameId = await persistExpiredGame({
      game, houseSecret, playerPubHex, playerHashHex,
      pkScriptHex: hex.encode(houseEscrowScript.pkScript),
      houseEscrow: { txid: 'f'.repeat(64), vout: 0, value: BET }, arkadeForfeitHex,
    })
    await server.recoverOrphanedHouseEscrows(deps)
    const state = JSON.parse((await deps.repos.games.get(gameId)).house_vtxos_json)
    expect(state.houseRefundTxid).toBeUndefined() // not touched
  }, 120_000)

  /**
   * Regression: if the player swept BOTH escrows via the playerForfeit leaf
   * (R1 forfeit), the house escrow VTXO is already spent. recoverOrphanedHouseEscrows
   * must handle the double-spend rejection gracefully — no exception propagated,
   * no houseRefundTxid written, return value reflects 0 new reclaims.
   *
   * Bootstraps its own minimal deps and injects a mock arkProvider.submitTx that
   * rejects with a double-spend error to simulate the forfeit-spent escrow.
   */
  it('handles a forfeit-spent house escrow gracefully (R1 forfeit regression)', async () => {
    if (!ready()) return

    const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinflip-forfeit-spent-test-'))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const serverMod = require('arkade-coinflip-server')
    process.env.DATA_DIR = testDataDir
    const testDeps = await serverMod.bootstrapDeps({ walletSettlementConfig: false })

    try {
      const now = Math.floor(Date.now() / 1000)
      const { game, houseSecret, playerPubHex, playerHashHex, arkadeForfeitHex } = await makeGame(now - 3600, now - 7200) // past CLTV so recovery attempts the refund
      const houseEscrowScript = getHouseEscrowScript(game)

      // Persist an expired game with a plausible (but fake) escrow outpoint —
      // we never escrowed anything; the point is to reach submitTx.
      const id = await persistExpiredGame({
        game, houseSecret, playerPubHex, playerHashHex,
        pkScriptHex: hex.encode(houseEscrowScript.pkScript),
        houseEscrow: { txid: 'a'.repeat(64), vout: 0, value: BET }, arkadeForfeitHex,
      }, testDeps.repos)

      // Patch deps: submitTx throws a double-spend error, simulating the player
      // having forfeit-swept both escrows before recovery ran.
      const forfeitSpentDeps = {
        ...testDeps,
        wallet: {
          ...testDeps.wallet,
          arkProvider: {
            ...testDeps.wallet.arkProvider,
            submitTx: async () => { throw new Error('double spend: input already spent') },
          },
        },
      }

      let recovered: number | undefined
      await expect(
        serverMod.recoverOrphanedHouseEscrows(forfeitSpentDeps).then((n: number) => { recovered = n }),
      ).resolves.not.toThrow()
      expect(recovered).toBe(0)

      const row = await testDeps.repos.games.get(id)
      const state = JSON.parse(row.house_vtxos_json)
      expect(state.houseRefundTxid).toBeUndefined() // no false "reclaimed" record
    } finally {
      if (fs.existsSync(testDataDir)) {
        try { fs.rmSync(testDataDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    }
  }, 120_000)
})
