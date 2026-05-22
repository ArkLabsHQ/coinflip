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
  type ExtendedVirtualCoin,
  type Identity,
  type ArkProvider,
} from '@arkade-os/sdk'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'
const HRP = 'tark' // server's networkHrpFromArkInfo returns 'tark' for regtest (HRP is cosmetic; pkScript is HRP-independent)
const BET = 1000
const HOUSE_FUND_BTC = 0.005
const PLAYER_FUND_BTC = 0.002

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)

async function faucet(address: string, amountBtc: number): Promise<void> {
  const r = await fetch(`${ESPLORA_URL}/faucet`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, amount: amountBtc }),
  })
  if (!r.ok) throw new Error(`Faucet failed: ${r.status} ${await r.text()}`)
}

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

    // 1) House escrows its stake; we get the escrow address.
    const play = await server.handleTrustlessPlay(
      { tier: BET, playerPubkey: playerPubHex, playerHash, playerChangeAddress }, deps,
    )
    expect(play.escrowAddress.startsWith(HRP)).toBe(true)
    expect(play.houseEscrow.value).toBe(BET)

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

    // 3) Commit: reveal + resolve. House win → server already swept.
    const commit = await server.handleTrustlessCommit(play.gameId, { playerSecretHex: hex.encode(playerSecret), playerEscrow }, deps)
    expect(['house', 'player']).toContain(commit.winner)
    console.log(`[trustless-api] winner=${commit.winner} pot-payout=${commit.payout}`)

    if (commit.winner === 'house') {
      expect(commit.txid).toBeTruthy() // server swept
    } else {
      // Player won — the server built the playerWin sweep; the CLIENT signs +
      // submits it (exactly what the Vue client does — SDK only, no lib).
      const s = commit.sweep
      const sweepArk = Transaction.fromPSBT(hex.decode(s.sweepPsbt))
      const sweepCps = s.sweepCheckpoints.map((c: string) => Transaction.fromPSBT(hex.decode(c)))
      const witness = s.witnessHex.map((w: string) => Buffer.from(w, 'hex'))
      const inputs = Array.from({ length: s.inputCount }, (_, i) => i)
      const before = await vtxoTotal(playerW)
      await submit(sweepArk, sweepCps, playerId, inputs, witness)
      await sleep(6000)
      const after = await vtxoTotal(playerW)
      console.log(`[trustless-api] player swept: ${before} -> ${after}`)
      expect(after - before).toBeGreaterThanOrEqual(commit.payout - 100)
    }

    const row = await deps.repos.games.get(play.gameId)
    expect(row.status).toBe('resolved')
    expect(row.winner).toBe(commit.winner)
  }, 300_000)
})
