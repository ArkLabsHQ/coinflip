/**
 * Crash-mid-sweep reconciliation e2e — covenant flow.
 *
 * If the server submits a covenant win-sweep but crashes before persisting the
 * result, the game is left `pending` with its escrow already spent on-Ark.
 * reconcilePendingSweeps detects that (indexer `isSpent`), decodes the spending
 * arkTx to see who the pot went to, and resolves the game accordingly.
 *
 * We reproduce the spent escrow exactly as production does: build the per-party
 * escrows, fund them, then settle the HOUSE win via the emulator-run win
 * covenant (buildCovenantSweepTransaction → emulator /v1/tx) — no winner
 * signature. Then we persist a PENDING game referencing the now-spent escrow and
 * run the reconciler.
 *
 * GATED: the covenant sweep needs the emulator (:7073), so this skips on the
 * arkd-only CI stack. The reconciler's winner-attribution LOGIC is also covered
 * deterministically (no stack) in reconcile-forfeit.unit.test.ts.
 */

import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  CoinflipEscrowScript, buildCovenantSweepTransaction, generateSecret, determineWinner,
  type EscrowInput,
} from 'arkade-coinflip'
import {
  buildOffchainTx, decodeTapscript, CSVMultisigTapscript, Transaction, ArkAddress,
  Wallet, SingleKey, InMemoryWalletRepository, InMemoryContractRepository,
  type ArkProvider, type Identity, type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { faucet } from './helpers'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMULATOR_URL = process.env.EMULATOR_URL || 'http://localhost:7073'
const HOUSE_FUND_BTC = 0.005
const PLAYER_FUND_BTC = 0.005
const BET = 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())

async function probe(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(8000) })).ok } catch { return false }
}
async function waitForBoarding(w: Wallet, min: number, t = 60_000) {
  const start = Date.now()
  while (Date.now() - start < t) { if ((await w.getBalance()).boarding.total >= min) return; await sleep(2000) }
  throw new Error('Timeout waiting for boarding')
}
async function waitForSettled(w: Wallet, min: number, t = 120_000) {
  const start = Date.now()
  while (Date.now() - start < t) { if ((await w.getBalance()).settled >= min) return; await sleep(2000) }
  throw new Error('Timeout waiting for settled')
}

let ready = false
beforeAll(async () => {
  const [ark, emu] = await Promise.all([probe(`${ARK_SERVER_URL}/v1/info`), probe(`${EMULATOR_URL}/v1/info`)])
  ready = ark && emu
  if (!ready) console.warn(`[skip] arkd=${ark} emulator=${emu} — covenant reconcile test needs both`)
}, 15_000)

describe('crash-mid-sweep reconciliation (covenant flow)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deps: any
  let arkProvider: ArkProvider
  let serverUnroll: CSVMultisigTapscript.Type
  let emulatorPubkey: Uint8Array
  let dataDir: string
  let playerW: Wallet
  let playerId: SingleKey

  beforeAll(async () => {
    if (!ready) return
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinflip-reconcile-test-'))
    process.env.DATA_DIR = dataDir
    process.env.ARK_SERVER_URL = ARK_SERVER_URL
    process.env.ESPLORA_URL = ESPLORA_URL
    process.env.EMULATOR_URL = EMULATOR_URL
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    server = require('arkade-coinflip-server')
    deps = await server.bootstrapDeps({ walletSettlementConfig: false })
    arkProvider = deps.wallet.arkProvider
    serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

    const info = (await (await fetch(`${EMULATOR_URL}/v1/info`)).json()) as { signerPubkey: string }
    emulatorPubkey = hex.decode(info.signerPubkey)

    await faucet(await deps.wallet.getBoardingAddress(), HOUSE_FUND_BTC)
    await waitForBoarding(deps.wallet, HOUSE_FUND_BTC * 1e8 * 0.9)
    await deps.wallet.settle()
    await waitForSettled(deps.wallet, BET * 3)

    playerId = SingleKey.fromRandomBytes()
    playerW = await Wallet.create({
      identity: playerId, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    await faucet(await playerW.getBoardingAddress(), PLAYER_FUND_BTC)
    await waitForBoarding(playerW, PLAYER_FUND_BTC * 1e8 * 0.9)
    await playerW.settle()
    await waitForSettled(playerW, BET)
  }, 240_000)

  afterAll(() => {
    if (dataDir && fs.existsSync(dataDir)) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  // Escrow `amount` from `w` into `pkScript`; returns the escrow outpoint.
  async function escrow(w: Wallet, id: Identity, pkScript: Uint8Array, amount: number): Promise<{ txid: string; vout: number; value: number }> {
    const v = (await w.getVtxos()).find((x: ExtendedVirtualCoin) => x.value >= amount)
    if (!v) throw new Error('no VTXO >= amount')
    const change = v.value - amount
    const outs: { script: Uint8Array; amount: bigint }[] = [{ script: pkScript, amount: BigInt(amount) }]
    if (change > 0) outs.push({ script: ArkAddress.decode(await w.getAddress()).pkScript, amount: BigInt(change) })
    const { arkTx, checkpoints } = buildOffchainTx(
      [{ txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript, tapTree: v.tapTree }], outs, serverUnroll,
    )
    const signed = await id.sign(arkTx, [0])
    const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(signed.toPSBT()), checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const finals: string[] = []
    for (const c of signedCheckpointTxs) {
      const cptx = Transaction.fromPSBT(base64.decode(c))
      const idx = Array.from({ length: cptx.inputsLength }, (_, i) => i)
      finals.push(base64.encode((await id.sign(cptx, idx)).toPSBT()))
    }
    await arkProvider.finalizeTx(arkTxid, finals)
    return { txid: arkTxid, vout: 0, value: amount }
  }

  it('resolves a pending game whose escrow was covenant-swept to the house', async () => {
    if (!ready) { console.warn('skipped — infra unavailable'); return }

    // Coin house win: 15B house secret vs 16B player secret → creator/house wins.
    const houseSecret = generateSecret('heads')
    const playerSecret = generateSecret('tails')
    expect(determineWinner(houseSecret, playerSecret)).toBe('creator')

    const housePub = await (deps.identity as Identity).xOnlyPublicKey()
    const playerPub = await playerId.xOnlyPublicKey()
    const serverPub = toXOnly(hex.decode(deps.arkInfo.signerPubkey))
    const houseAddr = await deps.wallet.getAddress()
    const playerAddr = await playerW.getAddress()
    const housePkScript = ArkAddress.decode(houseAddr).pkScript
    const playerPkScript = ArkAddress.decode(playerAddr).pkScript
    const now = Math.floor(Date.now() / 1000)
    const exitDelay = 86_528n

    const common = {
      creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey: serverPub,
      creatorHash: sha(houseSecret), playerHash: sha(playerSecret),
      finalExpiration: BigInt(now + 1200), exitDelay,
      arkadeForfeit: {
        emulatorPubkey, playerPayoutPkScript: playerPkScript, housePayoutPkScript: housePkScript,
        playerStake: BigInt(BET), houseStake: BigInt(BET),
      },
    }
    const houseEscrowScript = new CoinflipEscrowScript({ ...common, refundPubkey: housePub })
    const playerEscrowScript = new CoinflipEscrowScript({ ...common, refundPubkey: playerPub })

    // Fund both per-party escrows.
    const houseEscrow = await escrow(deps.wallet, deps.identity, houseEscrowScript.address('tark', serverPub).pkScript, BET)
    const playerEscrow = await escrow(playerW, playerId, playerEscrowScript.address('tark', serverPub).pkScript, BET)

    // Settle the HOUSE win via the win covenant (server pattern: build the sweep,
    // submit to the emulator, which cosigns the tweaked slot and forwards to arkd).
    const escrows: EscrowInput[] = [
      { script: houseEscrowScript, ...houseEscrow },
      { script: playerEscrowScript, ...playerEscrow },
    ]
    const sweep = buildCovenantSweepTransaction(deps.arkInfo, 'tark', {
      winner: 'house', escrows, payoutAddress: houseAddr, potAmount: BigInt(2 * BET),
      bothSecrets: [new Uint8Array(houseSecret), new Uint8Array(playerSecret)],
    })
    const resp = await fetch(`${EMULATOR_URL}/v1/tx`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arkTx: base64.encode(sweep.arkTx.toPSBT()),
        checkpointTxs: sweep.checkpoints.map((c) => base64.encode(c.toPSBT())),
      }),
    })
    if (!resp.ok) throw new Error(`emulator rejected sweep: ${resp.status} ${await resp.text()}`)
    await sleep(5000)

    // Persist a PENDING game referencing the now-spent escrow (the crash left the
    // resolve write undone), with the arkadeForfeit payout pins the reconciler
    // decodes against.
    const gameId = `reconcile-${Date.now()}`
    await deps.repos.games.save({
      id: gameId, tier: BET, playerPubkey: hex.encode(playerPub), playerChoice: 'trustless',
      playerHash: hex.encode(sha(playerSecret)), houseSecretHex: hex.encode(houseSecret),
      finalScriptHex: hex.encode(houseEscrowScript.address('tark', serverPub).pkScript),
      houseVtxosJson: JSON.stringify({
        finalExpiration: now + 1200, setupExpiration: now + 600,
        houseEscrow, playerEscrow,
        arkadeForfeit: {
          emulatorPubkeyHex: hex.encode(emulatorPubkey),
          playerPayoutPkScriptHex: hex.encode(playerPkScript),
          housePayoutPkScriptHex: hex.encode(housePkScript),
          playerStake: BET, houseStake: BET, exitDelay: Number(exitDelay),
        },
      }),
    })
    expect((await deps.repos.games.get(gameId)).status).toBe('pending')

    const reconciled = await server.reconcilePendingSweeps(deps)
    expect(reconciled).toBeGreaterThanOrEqual(1)

    const row = await deps.repos.games.get(gameId)
    expect(row.status).toBe('resolved')
    expect(row.winner).toBe('house') // pot was swept to the house
    console.log(`[reconcile-test] covenant-swept game resolved: winner=${row.winner}`)

    // Idempotent: a second pass leaves it resolved.
    expect(await server.reconcilePendingSweeps(deps)).toBe(0)
  }, 300_000)

  it('leaves a genuinely pending game (unspent escrow) untouched', async () => {
    if (!ready) return
    const gameId = `reconcile-unspent-${Date.now()}`
    const now = Math.floor(Date.now() / 1000)
    await deps.repos.games.save({
      id: gameId, tier: BET, playerPubkey: 'aa'.repeat(32), playerChoice: 'trustless',
      playerHash: 'bb'.repeat(32), houseSecretHex: hex.encode(generateSecret('heads')),
      finalScriptHex: 'cc',
      houseVtxosJson: JSON.stringify({ finalExpiration: now + 1200, setupExpiration: now + 600, houseEscrow: { txid: 'd'.repeat(64), vout: 0, value: BET } }),
    })
    await server.reconcilePendingSweeps(deps)
    expect((await deps.repos.games.get(gameId)).status).toBe('pending') // untouched
  }, 120_000)
})
