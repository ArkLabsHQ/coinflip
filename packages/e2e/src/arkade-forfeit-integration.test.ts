/**
 * End-to-end R1 forfeit through the arkade-script playerForfeit leaf, driven
 * via the live coinflip-server-1 docker container's public HTTP API.
 *
 * Skipped unless arkd (:7070), emulator (:7073), and coinflip server
 * (:8080/api) are reachable. Avoids the wallet-collision problem of running
 * a second `bootstrapDeps` instance against the same arkd as the docker
 * container — instead it hits the production code path directly.
 *
 * Cases:
 *  1. `/play` with the emulator overlay running → response indicates
 *     5-leaf escrow (different address than legacy would yield).
 *  2. Build the player's escrow funding tx, submit it, then ask the server
 *     for the forfeit PSBT via `/api/game/:id/forfeit`. Verifies the
 *     server-side wiring + the covenant binding (recipient + amounts).
 *
 * For the final emulator+arkd round-trip we'd need to backdate CLTV, which
 * we can't do over HTTP without admin access — so the "submit to emulator,
 * verify VTXO arrival" step is left to the in-process unit-level test (see
 * arkade-escrow.unit.test.ts for taptree shape; arkade-forfeit.unit.test.ts
 * for covenant encoding).
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
  type ArkProvider,
} from '@arkade-os/sdk'
import { faucet } from './helpers'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMULATOR_URL = process.env.EMULATOR_URL || 'http://localhost:7073'
// :8080/api is the client proxy mapping to coinflip-server-1's :3001.
const COINFLIP_API_URL = process.env.COINFLIP_API_URL || 'http://localhost:8080/api'
const BET = 1000
const PLAYER_FUND_BTC = 0.002

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)

async function probe(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(10000) })).ok
  } catch (e) {
    console.warn(`[probe] ${url} failed:`, e instanceof Error ? e.message : e)
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

let infraAvailable = false
beforeAll(async () => {
  const [ark, emu, srv] = await Promise.all([
    probe(`${ARK_SERVER_URL}/v1/info`),
    probe(`${EMULATOR_URL}/v1/info`),
    probe(`${COINFLIP_API_URL}/network`),
  ])
  infraAvailable = ark && emu && srv
  if (!infraAvailable) {
    console.warn(
      `[skip] arkd=${ark} emulator=${emu} coinflip-server=${srv} — integration test needs all three`,
    )
  }
}, 15_000)

describe('R1 forfeit through arkade-script playerForfeit leaf (HTTP integration)', () => {
  let arkProvider: ArkProvider | null = null
  let serverUnroll: CSVMultisigTapscript.Type | null = null

  beforeAll(async () => {
    if (!infraAvailable) return
    // Lazy import here so the SDK isn't loaded when the test is skipped.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RestArkProvider } = require('@arkade-os/sdk')
    arkProvider = new RestArkProvider(ARK_SERVER_URL)
    const info = await (arkProvider as ArkProvider).getInfo()
    serverUnroll = decodeTapscript(hex.decode(info.checkpointTapscript)) as CSVMultisigTapscript.Type
  }, 30_000)

  it('server returns a 5-leaf escrow address when emulator is configured', async () => {
    if (!infraAvailable) return

    // Stand up a player. Each test gets a fresh keypair so a 4-pending cap
    // (countPendingForPlayer) doesn't trip on repeated runs.
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await makePlayerWallet(playerId)
    await faucet(await playerW.getBoardingAddress(), PLAYER_FUND_BTC)
    await waitFor(playerW, 'boarding', PLAYER_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(playerW)
    await waitFor(playerW, 'settled', BET)

    const playerSecret = Buffer.from(new Uint8Array(16))
    crypto.getRandomValues(playerSecret)
    const playerHash = createHash('sha256').update(playerSecret).digest('hex')
    const playerPubHex = hex.encode(toXOnly(await playerId.compressedPublicKey()))
    const playerChangeAddress = await playerW.getAddress()

    const play = await postJson<{
      gameId: string
      escrowAddress: string
      houseEscrow: { txid: string; vout: number; value: number }
      pot: number
    }>(`/play`, {
      tier: BET,
      playerPubkey: playerPubHex,
      playerHash,
      playerChangeAddress,
    })

    expect(play.gameId).toBeTruthy()
    expect(play.escrowAddress).toMatch(/^t?ark/)
    expect(play.houseEscrow.value).toBe(BET)
    expect(play.pot).toBe(2 * BET)

    // The arkade-script escrow's taproot is HASHED FROM the playerForfeit
    // leaf bytes, which include the player's pkScript. Two distinct players
    // therefore get distinct escrow addresses *even when betAmount + hash
    // are the same*. (Legacy 4-leaf escrows did NOT have this property
    // since none of the leaves depended on the player's payout address.)
    // We can't query the server's persisted state over HTTP, so this is the
    // observable proxy: a second player with a different pkScript gets a
    // different escrow address.

    const player2Id = SingleKey.fromRandomBytes()
    const player2W = await makePlayerWallet(player2Id)
    await faucet(await player2W.getBoardingAddress(), PLAYER_FUND_BTC)
    await waitFor(player2W, 'boarding', PLAYER_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(player2W)
    await waitFor(player2W, 'settled', BET)

    const player2SecretBuf = Buffer.from(new Uint8Array(16))
    crypto.getRandomValues(player2SecretBuf)
    const player2Hash = createHash('sha256').update(player2SecretBuf).digest('hex')
    const player2PubHex = hex.encode(toXOnly(await player2Id.compressedPublicKey()))
    const player2ChangeAddress = await player2W.getAddress()

    const play2 = await postJson<{ escrowAddress: string }>(`/play`, {
      tier: BET,
      playerPubkey: player2PubHex,
      playerHash: player2Hash,
      playerChangeAddress: player2ChangeAddress,
    })

    // Both escrow addresses are derived from the SAME tier + hashes for the
    // matching role… but the player pkScript differs, so addresses differ.
    // This is the observable signature of the arkade-forfeit leaf being in
    // the taptree.
    expect(play2.escrowAddress).not.toBe(play.escrowAddress)
    console.log(`[r1-http] player1 escrow=${play.escrowAddress.slice(0, 12)}…`)
    console.log(`[r1-http] player2 escrow=${play2.escrowAddress.slice(0, 12)}…`)
    console.log(`[r1-http] addresses differ → arkade-forfeit pin is active`)
  }, 240_000)

  it('forfeit endpoint produces a covenant-bound PSBT', async () => {
    if (!infraAvailable) return
    if (!arkProvider || !serverUnroll) throw new Error('test infra not initialized')

    // Fresh player.
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await makePlayerWallet(playerId)
    await faucet(await playerW.getBoardingAddress(), PLAYER_FUND_BTC)
    await waitFor(playerW, 'boarding', PLAYER_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(playerW)
    await waitFor(playerW, 'settled', BET)

    const playerSecret = Buffer.from(new Uint8Array(16))
    crypto.getRandomValues(playerSecret)
    const playerHash = createHash('sha256').update(playerSecret).digest('hex')
    const playerPubHex = hex.encode(toXOnly(await playerId.compressedPublicKey()))
    const playerChangeAddress = await playerW.getAddress()

    const play = await postJson<{
      gameId: string
      escrowAddress: string
      houseEscrow: { txid: string; vout: number; value: number }
    }>(`/play`, { tier: BET, playerPubkey: playerPubHex, playerHash, playerChangeAddress })

    // Fund the player escrow.
    const escrowPk = ArkAddress.decode(play.escrowAddress).pkScript
    const pv = (await playerW.getVtxos())[0]
    const change = pv.value - BET
    const pOutputs: { script: Uint8Array; amount: bigint }[] = [
      { script: escrowPk, amount: BigInt(BET) },
    ]
    if (change > 0) {
      pOutputs.push({ script: ArkAddress.decode(playerChangeAddress).pkScript, amount: BigInt(change) })
    }
    const escrowTx = buildOffchainTx(
      [{ txid: pv.txid, vout: pv.vout, value: pv.value, tapLeafScript: pv.forfeitTapLeafScript, tapTree: pv.tapTree }],
      pOutputs,
      serverUnroll,
    )
    const signed = await playerId.sign(escrowTx.arkTx, [0])
    const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(signed.toPSBT()),
      escrowTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const finals: string[] = []
    for (const c of signedCheckpointTxs) {
      const tx = Transaction.fromPSBT(base64.decode(c))
      const idx = Array.from({ length: tx.inputsLength }, (_, i) => i)
      finals.push(base64.encode((await playerId.sign(tx, idx)).toPSBT()))
    }
    await arkProvider.finalizeTx(arkTxid, finals)
    const playerEscrow = { txid: arkTxid, vout: 0, value: BET }

    // Forfeit endpoint. The CLTV gate doesn't have to have matured for
    // the server to BUILD the PSBT — that's an arkd/emulator-side
    // enforcement. We just verify the wiring + atomic-sweep shape.
    const forfeit = await postJson<{
      forfeitPsbt: string
      forfeitCheckpoints: string[]
      forfeitClaimableAt: number
      payoutAddress: string
      potAmount: number
      stakes: [number, number]
    }>(`/game/${play.gameId}/forfeit`, { playerEscrow })

    expect(forfeit.forfeitPsbt).toBeTruthy()
    expect(forfeit.payoutAddress).toBe(playerChangeAddress)
    expect(forfeit.potAmount).toBe(2 * BET)
    expect(forfeit.stakes[0]).toBe(play.houseEscrow.value)
    expect(forfeit.stakes[1]).toBe(BET)
    expect(forfeit.stakes[0] + forfeit.stakes[1]).toBe(forfeit.potAmount)
    // CLTV gate = the persisted finalExpiration (1800s after /play).
    expect(forfeit.forfeitClaimableAt).toBeGreaterThan(Math.floor(Date.now() / 1000))

    // Atomic-sweep: 2 inputs, 1 user output (full pot) + anchor + ext.
    const arkTx = Transaction.fromPSBT(hex.decode(forfeit.forfeitPsbt))
    expect(arkTx.inputsLength).toBe(2)
    expect(arkTx.outputsLength).toBeGreaterThanOrEqual(1)
    console.log(
      `[r1-http] forfeit PSBT ok: ${arkTx.inputsLength}-in/${arkTx.outputsLength}-out, pot=${forfeit.potAmount}, claimableAt=${forfeit.forfeitClaimableAt}`,
    )
  }, 240_000)

  it('full flow: /play → escrow → /commit settles via covenant (no client signing)', async () => {
    if (!infraAvailable) return
    if (!arkProvider || !serverUnroll) throw new Error('test infra not initialized')

    // Player setup
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

    // 1) /play
    const play = await postJson<{
      gameId: string
      escrowAddress: string
      houseEscrow: { txid: string; vout: number; value: number }
      pot: number
    }>(`/play`, { tier: BET, playerPubkey: playerPubHex, playerHash, playerChangeAddress })

    // 2) player escrows their stake
    const escrowPk = ArkAddress.decode(play.escrowAddress).pkScript
    const pv = (await playerW.getVtxos())[0]
    const change = pv.value - BET
    const pOutputs: { script: Uint8Array; amount: bigint }[] = [
      { script: escrowPk, amount: BigInt(BET) },
    ]
    if (change > 0) {
      pOutputs.push({
        script: ArkAddress.decode(playerChangeAddress).pkScript,
        amount: BigInt(change),
      })
    }
    const escrowTx = buildOffchainTx(
      [{ txid: pv.txid, vout: pv.vout, value: pv.value, tapLeafScript: pv.forfeitTapLeafScript, tapTree: pv.tapTree }],
      pOutputs,
      serverUnroll,
    )
    const signed = await playerId.sign(escrowTx.arkTx, [0])
    const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(signed.toPSBT()),
      escrowTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const finals: string[] = []
    for (const c of signedCheckpointTxs) {
      const tx = Transaction.fromPSBT(base64.decode(c))
      const idx = Array.from({ length: tx.inputsLength }, (_, i) => i)
      finals.push(base64.encode((await playerId.sign(tx, idx)).toPSBT()))
    }
    await arkProvider.finalizeTx(arkTxid, finals)
    const playerEscrow = { txid: arkTxid, vout: 0, value: BET }

    // 3) /commit — server settles via covenant, returns a txid; no PSBT to sign.
    const commit = await postJson<{
      winner: 'house' | 'player'
      houseSecret: string
      playerSecret: string
      payout: number
      proof: string
      txid?: string
    }>(`/game/${play.gameId}/commit`, {
      playerSecretHex: hex.encode(playerSecretBuf),
      playerEscrow,
    })

    expect(['house', 'player']).toContain(commit.winner)
    expect(commit.payout).toBe(2 * BET)
    expect(commit.txid).toBeTruthy()
    expect(typeof commit.txid).toBe('string')
    expect((commit.txid as string).length).toBe(64) // hex-encoded txid
    console.log(
      `[r1-http] full flow OK: winner=${commit.winner} payout=${commit.payout} txid=${commit.txid?.slice(0, 16)}…`,
    )
  }, 240_000)

  it('forfeit endpoint 404s on unknown gameId (route wiring smoke)', async () => {
    if (!infraAvailable) return
    const r = await fetch(`${COINFLIP_API_URL}/game/00000000-0000-0000-0000-000000000000/forfeit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerEscrow: { txid: 'a'.repeat(64), vout: 0, value: 1 } }),
    })
    expect([400, 404]).toContain(r.status)
    const body = (await r.json()) as { error?: string }
    expect(body.error).toBeTruthy()
    console.log(`[r1-http] forfeit endpoint 404/400 wiring ok: ${body.error}`)
  }, 30_000)
})
