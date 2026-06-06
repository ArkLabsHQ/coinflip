/**
 * LOAD TEST (opt-in: set LOAD_TEST=1) — 100 full trustless games across 5
 * concurrent player wallets, against the live regtest stack.
 *
 * Each wallet plays its 20-game share sequentially (play → escrow → commit);
 * all 5 wallets run in parallel, so up to 5 full games hit the shared house at
 * once. Exercises the real concurrency surface: distinct house-VTXO reservations
 * under contention, the per-game commit lock, covenant settlement, and pool
 * replenishment. Every game must reach `resolved`.
 *
 * Faithful to the real runtime: it starts the expiry timer that main() runs (so
 * abandoned games' reservations release), times out any single game so one hang
 * can't freeze the run, retries transient errors like a real client, and logs
 * progress live.
 *
 * Skipped by default (CI's e2e lane ignores it). Run locally with a FRESH
 * DATA_DIR so the house wallet starts clean on the current chain:
 *
 *   cd packages/e2e
 *   DATA_DIR=./data-load LOAD_TEST=1 \
 *     ARK_SERVER_URL=http://localhost:7070 ESPLORA_URL=http://localhost:3000/api \
 *     EMULATOR_URL=http://localhost:7073 EMULATOR_PUBLIC_URL=http://localhost:7073 \
 *     npx jest --runInBand --forceExit --testTimeout=1800000 src/load-100-games.test.ts
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
  RestIndexerProvider,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  type Identity,
  type ArkProvider,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { faucet } from './helpers'

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { reservations } = require('arkade-coinflip-server/dist/vtxo-pool.js')

/**
 * Escrow contract version under test. Read from env BEFORE the server
 * module loads (the server's newGameEscrowVersion() snapshots the same
 * env at /play time). Defaults to v2 to preserve the existing CI lane.
 *
 * v2 secret: random 16 bytes (the variable-odds VARIABLE_ODDS_BASE_LEN coin).
 * v3 secret: `[digit] ‖ salt` from `packets.encodeReveal(digit, 16-byte salt)`
 *   — coin maps to n=2 so digit ∈ {0, 1}; sha256 of those bytes IS the
 *   on-chain digitHash that the win-predicate verifies, so playerHash
 *   computation stays the same.
 */
const ESCROW_VERSION: 'v2' | 'v3' = (process.env.ESCROW_VERSION ?? '').toLowerCase() === 'v3' ? 'v3' : 'v2'
// Generate a player secret in the right wire format for this version.
function makePlayerSecret(): Uint8Array {
  if (ESCROW_VERSION === 'v3') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { commitDigit, randomUniformInt } = require('arkade-coinflip')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { packets } = require('@arklabshq/contract-workflows-prototype')
    const c = commitDigit(randomUniformInt(2), 2)
    return packets.encodeReveal(c.digit, c.salt)
  }
  const secret = new Uint8Array(16)
  crypto.getRandomValues(secret)
  return secret
}

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const BET = 1000
const WALLETS = Number(process.env.LOAD_WALLETS || 5)
const GAMES_PER_WALLET = Number(process.env.LOAD_GAMES || 20)
const TOTAL = WALLETS * GAMES_PER_WALLET // default 5 × 20 = 100
const HOUSE_FUND_BTC = 0.02
const PLAYER_FUND_BTC = 0.006 // 600k sats/wallet — survives losing streaks + retries that burn an escrow
const POOL_FRAGMENTS = 40
const GAME_TIMEOUT_MS = 90_000 // a normal game is ~5-10s; 90s ⇒ treat as a failure, never hang
const GAME_RETRIES = 3 // retry a transient play/escrow/commit failure, like a real client

const indexer = new RestIndexerProvider(ARK_SERVER_URL)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)

// Confirm arkd has INDEXED a freshly-submitted VTXO. A well-behaved client waits
// for its escrow to land before asking the server to settle; the server also
// retries VTXO_NOT_FOUND, so this is belt-and-suspenders that keeps the load run
// deterministic for CI.
async function waitForArkVtxo(txid: string, vout: number, t = 20_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < t) {
    try {
      const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid, vout }] })
      if (vtxos.some((v) => v.txid === txid && v.vout === vout && !v.isSpent)) return
    } catch { /* transient indexer hiccup — keep polling */ }
    await sleep(400)
  }
  throw new Error(`escrow vtxo ${txid}:${vout} not indexed within ${t}ms`)
}
const opid = (v: { txid: string; vout: number }) => `${v.txid}:${v.vout}`
const now = () => new Date().toISOString().slice(11, 19)
const log = (m: string) => process.stdout.write(`[load ${now()}] ${m}\n`)

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

async function settleWithRetry(w: Wallet, tries = 4): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await w.settle(); return } catch (e) {
      if (i === tries - 1) throw e
      await sleep(5000)
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${label}`)), ms)),
  ])
}

let arkAvailable = false
beforeAll(async () => {
  try {
    arkAvailable = (await fetch(`${ARK_SERVER_URL}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok
  } catch { arkAvailable = false }
}, 10_000)

const RUN = !!process.env.LOAD_TEST
const maybe = RUN ? describe : describe.skip

maybe('load: 100 games across 5 concurrent wallets', () => {
  let server: any
  let deps: any
  let arkProvider: ArkProvider
  let serverUnroll: CSVMultisigTapscript.Type
  let expiryTimer: NodeJS.Timeout | undefined

  beforeAll(async () => {
    if (!arkAvailable) return
    process.env.ARK_SERVER_URL = ARK_SERVER_URL
    process.env.ESPLORA_URL = ESPLORA_URL
    // Propagate the version under test to the server's /play handler. The
    // server reads ESCROW_VERSION at /play time via newGameEscrowVersion();
    // setting it here BEFORE require() guarantees the very first /play uses
    // the right version, before any game state is persisted.
    if (ESCROW_VERSION === 'v3') process.env.ESCROW_VERSION = 'v3'
    log(`load test running in ${ESCROW_VERSION.toUpperCase()} escrow mode`)
    server = require('arkade-coinflip-server')
    deps = await server.bootstrapDeps({ walletSettlementConfig: false })
    arkProvider = deps.wallet.arkProvider
    serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

    // Replicate the real runtime: the expiry timer releases reservations held by
    // any abandoned pending game (bootstrapDeps alone doesn't start it).
    expiryTimer = server.startExpiryTimer(deps)

    await faucet(await deps.wallet.getBoardingAddress(), HOUSE_FUND_BTC)
    await waitFor(deps.wallet, 'boarding', HOUSE_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(deps.wallet)
    await waitFor(deps.wallet, 'settled', BET * 50)
    await server.ensureHouseVtxoPool(deps, { targetCount: POOL_FRAGMENTS, pieceSize: BET * 2 })

    const start = Date.now()
    let usable = 0
    while (Date.now() - start < 90_000) {
      usable = (await deps.wallet.getVtxos()).filter((v: { value: number }) => v.value >= BET).length
      if (usable >= Math.min(POOL_FRAGMENTS, WALLETS * 3)) break
      await sleep(2000)
    }
    log(`house ready: ${usable} usable VTXO(s) >= ${BET} sat`)
  }, 600_000)

  afterAll(() => { if (expiryTimer) clearInterval(expiryTimer) })

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

  async function pickSpendable(w: Wallet, spent: Set<string>, t = 30_000): Promise<ExtendedVirtualCoin> {
    const start = Date.now()
    while (Date.now() - start < t) {
      const cands = (await w.getVtxos())
        .filter((v) => v.value >= BET && !spent.has(opid(v)))
        .sort((a, b) => b.value - a.value)
      if (cands.length) return cands[0]
      await sleep(1000)
    }
    throw new Error('no spendable player VTXO appeared')
  }

  // Free a game whose escrow/commit failed: release its house reservation and
  // mark the row expired so the pool recovers immediately (don't wait 5 min).
  async function releaseGame(gameId: string): Promise<void> {
    try { reservations.release(gameId) } catch { /* best effort */ }
    try { await deps.repos.games.update(gameId, { status: 'expired' }) } catch { /* best effort */ }
  }

  // One full game attempt: /play (retry transient pool-busy) → escrow → commit.
  async function attemptGame(w: Wallet, id: Identity, pubHex: string, changeAddr: string, spent: Set<string>): Promise<'house' | 'player'> {
    const secret = makePlayerSecret()
    const playerHash = createHash('sha256').update(Buffer.from(secret)).digest('hex')

    let play: any
    for (let attempt = 0; ; attempt++) {
      try {
        play = await server.handleTrustlessPlay({ tier: BET, playerPubkey: pubHex, playerHash, playerChangeAddress: changeAddr }, deps)
        break
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/busy|free.*VTXO|Too many pending/i.test(msg) && attempt < 15) { await sleep(500 + attempt * 300); continue }
        throw e
      }
    }

    try {
      const pv = await pickSpendable(w, spent)
      spent.add(opid(pv))
      const escrowPk = ArkAddress.decode(play.escrowAddress).pkScript
      const change = pv.value - BET
      const outs: { script: Uint8Array; amount: bigint }[] = [{ script: escrowPk, amount: BigInt(BET) }]
      if (change > 0) outs.push({ script: ArkAddress.decode(changeAddr).pkScript, amount: BigInt(change) })
      const tx = buildOffchainTx(
        [{ txid: pv.txid, vout: pv.vout, value: pv.value, tapLeafScript: pv.forfeitTapLeafScript, tapTree: pv.tapTree }],
        outs, serverUnroll,
      )
      const escrowTxid = await submit(tx.arkTx, tx.checkpoints, id, [0])
      await waitForArkVtxo(escrowTxid, 0) // confirm the escrow is indexed before the sweep spends it
      const commit = await server.handleTrustlessCommit(
        play.gameId, { playerSecretHex: hex.encode(secret), playerEscrow: { txid: escrowTxid, vout: 0, value: BET } }, deps,
      )
      const row = await deps.repos.games.get(play.gameId)
      if (row.status !== 'resolved') throw new Error(`status ${row.status} != resolved`)
      return commit.winner
    } catch (e) {
      await releaseGame(play.gameId) // free the house VTXO this doomed game reserved
      throw e
    }
  }

  it('plays 100 games (5 wallets × 20, in parallel) — every game resolves', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    const wallets = await Promise.all(Array.from({ length: WALLETS }, async (_, i) => {
      const id = SingleKey.fromRandomBytes()
      const w = await makePlayerWallet(id)
      await faucet(await w.getBoardingAddress(), PLAYER_FUND_BTC)
      await waitFor(w, 'boarding', PLAYER_FUND_BTC * 1e8 * 0.9)
      await settleWithRetry(w)
      await waitFor(w, 'settled', BET)
      return { idx: i, id, w, pubHex: hex.encode(toXOnly(await id.compressedPublicKey())), changeAddr: await w.getAddress(), spent: new Set<string>() }
    }))
    log(`${WALLETS} wallets funded; starting ${TOTAL} games (peak concurrency ${WALLETS})…`)

    const t0 = Date.now()
    const tally = { house: 0, player: 0 }
    const failures: string[] = []
    let done = 0

    const runWallet = async (wal: typeof wallets[number]) => {
      await sleep(wal.idx * 400) // small stagger to avoid a thundering herd on /play
      for (let g = 0; g < GAMES_PER_WALLET; g++) {
        let lastErr = ''
        for (let attempt = 0; attempt < GAME_RETRIES; attempt++) {
          try {
            const winner = await withTimeout(
              attemptGame(wal.w, wal.id, wal.pubHex, wal.changeAddr, wal.spent),
              GAME_TIMEOUT_MS, `w${wal.idx} g${g}`,
            )
            tally[winner]++
            log(`w${wal.idx} g${g} → ${winner}  (${++done}/${TOTAL})`)
            lastErr = ''
            break
          } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e)
            if (attempt < GAME_RETRIES - 1) { log(`w${wal.idx} g${g} retry ${attempt + 1}: ${lastErr}`); await sleep(1000) }
          }
        }
        if (lastErr) { failures.push(`w${wal.idx} g${g}: ${lastErr}`); log(`w${wal.idx} g${g} FAILED: ${lastErr}`) }
      }
    }
    await Promise.all(wallets.map(runWallet))

    const secs = (Date.now() - t0) / 1000
    log(`DONE: ${done}/${TOTAL} resolved in ${secs.toFixed(1)}s (${(done / secs).toFixed(2)} games/s) — house ${tally.house}, player ${tally.player}, failures ${failures.length}`)
    if (failures.length) log('failures:\n  ' + failures.slice(0, 25).join('\n  '))

    const resolved = await deps.repos.games.list({ status: 'resolved', limit: 1000 })
    log(`DB resolved rows: ${resolved.length}`)

    expect(failures).toEqual([])
    expect(done).toBe(TOTAL)
  }, 600_000)
})
