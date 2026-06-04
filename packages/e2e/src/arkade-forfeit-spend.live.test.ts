/**
 * LIVE end-to-end R1 forfeit SPEND through the arkade-script `playerForfeit`
 * leaf — the on-chain round-trip the structural integration test
 * (arkade-forfeit-integration.test.ts) deliberately stops short of.
 *
 * Flow (the "server stalled after I revealed" scenario):
 *   1. /play, player escrows the stake.
 *   2. Fetch the forfeit PSBT from /game/:id/forfeit.
 *   3. DON'T /commit (simulates the stall).
 *   4. Fast-forward chain time past the forfeit CLTV (forfeitClaimableAt) via
 *      bitcoind setmocktime + mining (median-time-past is what consensus checks).
 *   5. Submit the forfeit to the EMULATOR /v1/tx exactly as the client's
 *      `claimForfeit` does (sign player slots [0,1]; emulator co-signs the
 *      tweaked covenant slot and forwards to arkd).
 *   6. Assert the house escrow is now SPENT on-Ark and the player received the
 *      full pot — i.e. the covenant actually paid out.
 *
 * GATED + OPT-IN: needs arkd (:7070), the emulator (:7073) and the coinflip
 * server (:8080/api) all reachable AND `RUN_LIVE_FORFEIT=1`. The opt-in is
 * mandatory because step 4 freezes the shared node clock (setmocktime), which
 * would perturb every other test against the same stack — so this must run in
 * isolation, and you should restart the regtest stack afterwards.
 *
 * Run it (full local stack up):
 *   RUN_LIVE_FORFEIT=1 npx jest arkade-forfeit-spend.live.test.ts
 */

import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import {
  buildOffchainTx,
  decodeTapscript,
  CSVMultisigTapscript,
  Transaction,
  ArkAddress,
  Wallet,
  SingleKey,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  RestIndexerProvider,
  type ArkProvider,
} from '@arkade-os/sdk'
import { faucet, setChainTime, mineBlock, sleep } from './helpers'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMULATOR_URL = process.env.EMULATOR_URL || 'http://localhost:7073'
const COINFLIP_API_URL = process.env.COINFLIP_API_URL || 'http://localhost:8080/api'
const OPT_IN = process.env.RUN_LIVE_FORFEIT === '1'
const BET = 1000
const PLAYER_FUND_BTC = 0.002

const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)

async function probe(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(10000) })).ok
  } catch {
    return false
  }
}

async function makePlayerWallet(id: SingleKey): Promise<Wallet> {
  return Wallet.create({
    identity: id,
    arkServerUrl: ARK_SERVER_URL,
    esploraUrl: ESPLORA_URL,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
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

async function settleWithRetry(w: Wallet, tries = 3): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await w.settle()
      return
    } catch (e) {
      if (i === tries - 1) throw e
      await sleep(5000)
    }
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${COINFLIP_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`)
  return (await r.json()) as T
}

let ready = false
beforeAll(async () => {
  if (!OPT_IN) {
    console.warn('[skip] live forfeit-spend test is opt-in — set RUN_LIVE_FORFEIT=1 (it freezes the node clock).')
    return
  }
  const [ark, emu, srv] = await Promise.all([
    probe(`${ARK_SERVER_URL}/v1/info`),
    probe(`${EMULATOR_URL}/v1/info`),
    probe(`${COINFLIP_API_URL}/network`),
  ])
  ready = ark && emu && srv
  if (!ready) console.warn(`[skip] arkd=${ark} emulator=${emu} coinflip-server=${srv} — live forfeit-spend needs all three`)
}, 30_000)

describe('R1 forfeit on-chain SPEND through playerForfeit (live)', () => {
  it('player sweeps the full pot after the forfeit CLTV matures', async () => {
    if (!ready) return

    const arkProvider = new RestIndexerProvider(ARK_SERVER_URL) as unknown as ArkProvider
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RestArkProvider } = require('@arkade-os/sdk')
    const ark = new RestArkProvider(ARK_SERVER_URL) as ArkProvider
    const info = await ark.getInfo()
    const serverUnroll = decodeTapscript(hex.decode(info.checkpointTapscript)) as CSVMultisigTapscript.Type
    const indexer = new RestIndexerProvider(ARK_SERVER_URL)

    // ── Player setup ──────────────────────────────────────────────────────
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await makePlayerWallet(playerId)
    await faucet(await playerW.getBoardingAddress(), PLAYER_FUND_BTC)
    await waitFor(playerW, 'boarding', PLAYER_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(playerW)
    await waitFor(playerW, 'settled', BET)

    const playerSecretBuf = Buffer.from(new Uint8Array(16))
    crypto.getRandomValues(playerSecretBuf)
    const playerHash = createHash('sha256').update(playerSecretBuf).digest('hex')
    const playerPubHex = hex.encode(toXOnly(await playerId.compressedPublicKey()))
    const playerChangeAddress = await playerW.getAddress()
    const playerPayoutScriptHex = hex.encode(ArkAddress.decode(playerChangeAddress).pkScript)

    // ── 1) /play ──────────────────────────────────────────────────────────
    const play = await postJson<{
      gameId: string
      escrowAddress: string
      houseEscrow: { txid: string; vout: number; value: number }
      pot: number
    }>(`/play`, { tier: BET, playerPubkey: playerPubHex, playerHash, playerChangeAddress })
    expect(play.pot).toBe(2 * BET)

    // ── 2) player escrows the stake ───────────────────────────────────────
    const escrowPk = ArkAddress.decode(play.escrowAddress).pkScript
    const pv = (await playerW.getVtxos())[0]
    const change = pv.value - BET
    const pOutputs: { script: Uint8Array; amount: bigint }[] = [{ script: escrowPk, amount: BigInt(BET) }]
    if (change > 0) pOutputs.push({ script: ArkAddress.decode(playerChangeAddress).pkScript, amount: BigInt(change) })
    const escrowTx = buildOffchainTx(
      [{ txid: pv.txid, vout: pv.vout, value: pv.value, tapLeafScript: pv.forfeitTapLeafScript, tapTree: pv.tapTree }],
      pOutputs,
      serverUnroll,
    )
    const signedEscrow = await playerId.sign(escrowTx.arkTx, [0])
    const { arkTxid, signedCheckpointTxs } = await ark.submitTx(
      base64.encode(signedEscrow.toPSBT()),
      escrowTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const finals: string[] = []
    for (const c of signedCheckpointTxs) {
      const cptx = Transaction.fromPSBT(base64.decode(c))
      const idx = Array.from({ length: cptx.inputsLength }, (_, i) => i)
      finals.push(base64.encode((await playerId.sign(cptx, idx)).toPSBT()))
    }
    await ark.finalizeTx(arkTxid, finals)
    const playerEscrow = { txid: arkTxid, vout: 0, value: BET }

    // ── 3) fetch forfeit PSBT, do NOT /commit (server "stalled") ──────────
    const forfeit = await postJson<{
      forfeitPsbt: string
      forfeitCheckpoints: string[]
      forfeitClaimableAt: number
      payoutAddress: string
      potAmount: number
    }>(`/game/${play.gameId}/forfeit`, { playerEscrow })
    expect(forfeit.payoutAddress).toBe(playerChangeAddress)
    expect(forfeit.potAmount).toBe(2 * BET)

    // ── 4) fast-forward past the forfeit CLTV ─────────────────────────────
    await setChainTime(forfeit.forfeitClaimableAt + 120, 12)

    // ── 5) submit the forfeit to the emulator (mirrors client claimForfeit) ─
    const arkTx = Transaction.fromPSBT(hex.decode(forfeit.forfeitPsbt))
    const signedForfeit = await playerId.sign(arkTx, [0, 1]) // both player slots
    const cps = forfeit.forfeitCheckpoints.map((c) => Transaction.fromPSBT(hex.decode(c)))
    const resp = await fetch(`${EMULATOR_URL}/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arkTx: base64.encode(signedForfeit.toPSBT()),
        checkpointTxs: cps.map((c) => base64.encode(c.toPSBT())),
      }),
    })
    if (!resp.ok) throw new Error(`emulator /v1/tx rejected forfeit: ${resp.status} ${await resp.text()}`)
    await mineBlock(1)

    // ── 6) assert the covenant paid out ───────────────────────────────────
    // (a) the house escrow is now spent on-Ark.
    let houseSpent = false
    for (let i = 0; i < 15 && !houseSpent; i++) {
      const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid: play.houseEscrow.txid, vout: play.houseEscrow.vout }] })
      houseSpent = vtxos.some((v) => v.isSpent)
      if (!houseSpent) await sleep(2000)
    }
    expect(houseSpent).toBe(true)

    // (b) a fresh VTXO pays the player's payout script with the full pot.
    let potToPlayer = false
    for (let i = 0; i < 15 && !potToPlayer; i++) {
      const { vtxos } = await indexer.getVtxos({ scripts: [playerPayoutScriptHex] })
      potToPlayer = vtxos.some((v) => v.value === 2 * BET && !v.isSpent)
      if (!potToPlayer) await sleep(2000)
    }
    expect(potToPlayer).toBe(true)
    console.log(`[r1-live] forfeit swept: house escrow spent, player received pot=${2 * BET}`)
  }, 600_000)
})
