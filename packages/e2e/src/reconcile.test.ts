/**
 * Crash-mid-sweep reconciliation e2e. If the server submits a house-win sweep
 * but crashes before persisting the result, the game is left `pending` with its
 * escrow already spent on-Ark. reconcilePendingSweeps detects that (indexer
 * `isSpent`) and resolves it to a house win — player wins are persisted resolved
 * BEFORE the escrow is ever spent, so a pending+spent escrow is unambiguous.
 *
 * We reproduce the spent escrow: escrow a house stake into a house-win coin
 * escrow and sweep it (creatorWin), then persist a pending game referencing that
 * now-spent outpoint and run the reconciler.
 */

import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CoinflipEscrowScript, buildSweepTransaction, generateSecret } from 'arkade-coinflip'
import {
  buildOffchainTx, decodeTapscript, CSVMultisigTapscript, ConditionWitness, setArkPsbtField,
  Transaction, ArkAddress, SingleKey, type ArkProvider, type Identity, type ExtendedVirtualCoin,
} from '@arkade-os/sdk'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'
const HOUSE_FUND_BTC = 0.005
const BET = 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())

async function faucet(address: string, amountBtc: number): Promise<void> {
  const r = await fetch(`${ESPLORA_URL}/faucet`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, amount: amountBtc }),
  })
  if (!r.ok) throw new Error(`Faucet failed: ${r.status} ${await r.text()}`)
}
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

describe('crash-mid-sweep reconciliation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deps: any
  let arkProvider: ArkProvider
  let serverUnroll: CSVMultisigTapscript.Type
  let dataDir: string

  beforeAll(async () => {
    if (!arkAvailable) return
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinflip-reconcile-test-'))
    process.env.DATA_DIR = dataDir
    process.env.ARK_SERVER_URL = ARK_SERVER_URL
    process.env.ESPLORA_URL = ESPLORA_URL
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    server = require('arkade-coinflip-server')
    deps = await server.bootstrapDeps({ walletSettlementConfig: false })
    arkProvider = deps.wallet.arkProvider
    serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
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

  // Single-party submit by the house, with a condition witness on every input.
  async function submit(arkTx: Transaction, checkpoints: Transaction[], inputs: number[], witness?: Uint8Array[]): Promise<string> {
    if (witness) for (const i of inputs) setArkPsbtField(arkTx, i, ConditionWitness, witness)
    const signed = await (deps.identity as Identity).sign(arkTx, inputs)
    const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(signed.toPSBT()), checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const finals: string[] = []
    for (const c of signedCheckpointTxs) {
      const tx = Transaction.fromPSBT(base64.decode(c))
      const idx = Array.from({ length: tx.inputsLength }, (_, i) => i)
      if (witness) for (const i of idx) setArkPsbtField(tx, i, ConditionWitness, witness)
      finals.push(base64.encode((await (deps.identity as Identity).sign(tx, idx)).toPSBT()))
    }
    await arkProvider.finalizeTx(arkTxid, finals)
    return arkTxid
  }

  it('resolves a pending game whose house escrow is already spent (house win)', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    // House-win coin secrets (15B vs 16B → different lengths → creator/house wins).
    const houseSecret = generateSecret('heads') // 15B
    const playerSecret = generateSecret('tails') // 16B
    const housePub = await (deps.identity as Identity).xOnlyPublicKey()
    const playerPub = toXOnly(await SingleKey.fromRandomBytes().compressedPublicKey())
    const serverPub = toXOnly(hex.decode(deps.arkInfo.signerPubkey))
    const now = Math.floor(Date.now() / 1000)

    const escrowScript = new CoinflipEscrowScript({
      creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey: serverPub,
      creatorHash: sha(houseSecret), playerHash: sha(playerSecret),
      finalExpiration: BigInt(now + 1200), penaltyTimelockSeconds: 1024n,
      refundPubkey: housePub,
    })
    const pk = escrowScript.address('tark', serverPub).pkScript

    // Escrow the house stake into the escrow address.
    const v = (await deps.wallet.getVtxos()).find((x: ExtendedVirtualCoin) => x.value >= BET)
    if (!v) throw new Error('no house VTXO')
    const change = v.value - BET
    const outs: { script: Uint8Array; amount: bigint }[] = [{ script: pk, amount: BigInt(BET) }]
    if (change > 0) outs.push({ script: ArkAddress.decode(await deps.wallet.getAddress()).pkScript, amount: BigInt(change) })
    const esc = buildOffchainTx([{ txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript, tapTree: v.tapTree }], outs, serverUnroll)
    const escTxid = await submit(esc.arkTx, esc.checkpoints, [0])
    const houseEscrow = { txid: escTxid, vout: 0, value: BET }

    // Sweep it via creatorWin (house wins) — now the escrow is SPENT on-Ark,
    // exactly as a real house-win sweep would leave it.
    const sweep = buildSweepTransaction(deps.arkInfo, 'tark', {
      winner: 'house', escrows: [{ script: escrowScript, ...houseEscrow }],
      payoutAddress: await deps.wallet.getAddress(), houseAddress: await deps.wallet.getAddress(), rake: 0,
    })
    await submit(sweep.arkTx, sweep.checkpoints, [0], [new Uint8Array(houseSecret), new Uint8Array(playerSecret)])
    await sleep(4000)

    // Persist a PENDING game referencing the now-spent escrow (the crash left it
    // pending — the resolve write never landed).
    const gameId = `reconcile-${Date.now()}`
    await deps.repos.games.save({
      id: gameId, tier: BET, playerPubkey: hex.encode(playerPub), playerChoice: 'trustless',
      playerHash: hex.encode(sha(playerSecret)), houseSecretHex: hex.encode(houseSecret),
      finalScriptHex: hex.encode(pk),
      houseVtxosJson: JSON.stringify({ finalExpiration: now + 1200, setupExpiration: now + 600, houseEscrow }),
    })
    expect((await deps.repos.games.get(gameId)).status).toBe('pending')

    const reconciled = await server.reconcilePendingSweeps(deps)
    expect(reconciled).toBeGreaterThanOrEqual(1)

    const row = await deps.repos.games.get(gameId)
    expect(row.status).toBe('resolved')
    expect(row.winner).toBe('house')
    console.log(`[reconcile-test] crash-mid-sweep game resolved: winner=${row.winner}`)

    // Idempotent: a second pass leaves it resolved (already not pending).
    const again = await server.reconcilePendingSweeps(deps)
    expect(again).toBe(0)
  }, 300_000)

  it('leaves a genuinely pending game (unspent escrow) untouched', async () => {
    if (!arkAvailable) return
    // A fake unspent outpoint → indexer reports not-spent (or unknown) → skipped.
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
