/**
 * Variable-odds resolution e2e — covenant flow (server + emulator settle).
 *
 * In the covenant design the winner signs nothing: the server resolves the game
 * via the emulator-bound win covenant (the odds condition is enforced by the
 * arkade-script the emulator runs). So we drive the real production path over
 * HTTP — POST /play with odds, escrow the stake, POST /commit — and assert the
 * server-settled outcome is consistent with the off-chain odds math
 * (determineVariableWinner) on the REVEALED secrets, and that the full pot was
 * paid out.
 *
 * The house digit is chosen server-side (CSPRNG), so we can't force a specific
 * roll; instead we play several games per odds config and check each resolved
 * outcome matches the math for its revealed secret lengths.
 *
 * GATED: needs arkd (:7070), the emulator (:7073) and the coinflip server
 * (:8080/api) all reachable (the covenant settlement requires the emulator, so
 * this skips on the arkd-only CI stack — like arkade-forfeit-integration).
 */

import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import {
  buildOffchainTx, decodeTapscript, CSVMultisigTapscript, Transaction, ArkAddress,
  Wallet, SingleKey, InMemoryWalletRepository, InMemoryContractRepository,
  type ArkProvider,
} from '@arkade-os/sdk'
import { determineVariableWinner, VARIABLE_ODDS_BASE_LEN } from 'arkade-coinflip'
import { faucet } from './helpers'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMULATOR_URL = process.env.EMULATOR_URL || 'http://localhost:7073'
const COINFLIP_API_URL = process.env.COINFLIP_API_URL || 'http://localhost:8080/api'
const BET = 1000
const PLAYER_FUND_BTC = 0.01

const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function probe(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(10000) })).ok } catch { return false }
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

async function settleWithRetry(w: Wallet, tries = 3): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await w.settle(); return } catch (e) { if (i === tries - 1) throw e; await sleep(5000) }
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${COINFLIP_API_URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`)
  return (await r.json()) as T
}

let ready = false
let arkProvider: ArkProvider | null = null
let serverUnroll: CSVMultisigTapscript.Type | null = null

beforeAll(async () => {
  const [ark, emu, srv] = await Promise.all([
    probe(`${ARK_SERVER_URL}/v1/info`),
    probe(`${EMULATOR_URL}/v1/info`),
    probe(`${COINFLIP_API_URL}/network`),
  ])
  ready = ark && emu && srv
  if (!ready) {
    console.warn(`[skip] arkd=${ark} emulator=${emu} coinflip-server=${srv} — variable-odds covenant test needs all three`)
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RestArkProvider } = require('@arkade-os/sdk')
  arkProvider = new RestArkProvider(ARK_SERVER_URL)
  const info = await (arkProvider as ArkProvider).getInfo()
  serverUnroll = decodeTapscript(hex.decode(info.checkpointTapscript)) as CSVMultisigTapscript.Type
}, 30_000)

interface PlayResp {
  gameId: string
  escrowAddress: string
  houseEscrow: { txid: string; vout: number; value: number }
  pot: number
}
interface CommitResp {
  winner: 'house' | 'player'
  houseSecret: string
  playerSecret: string
  payout: number
  roll: number | null
  txid?: string
}

describe('variable-odds resolution via covenant settlement (HTTP)', () => {
  // Play one variable-odds game end-to-end and return the asserted outcome.
  async function playOne(player: { id: SingleKey; w: Wallet }, n: number, target: number, lo: number): Promise<void> {
    if (!arkProvider || !serverUnroll) throw new Error('infra not initialized')

    // Player picks a uniform digit in [0, n); the length encodes it.
    const digit = Math.floor(Math.random() * n)
    const secret = new Uint8Array(VARIABLE_ODDS_BASE_LEN + digit)
    crypto.getRandomValues(secret)
    const playerHash = hex.encode(sha(secret))
    const playerPubHex = hex.encode(toXOnly(await player.id.compressedPublicKey()))
    const playerChangeAddress = await player.w.getAddress()

    const play = await postJson<PlayResp>(`/play`, {
      tier: BET, playerPubkey: playerPubHex, playerHash, playerChangeAddress,
      oddsN: n, oddsTarget: target, oddsLo: lo,
    })
    expect(play.pot).toBe(2 * BET)

    // Escrow the player's stake into the escrow address.
    const escrowPk = ArkAddress.decode(play.escrowAddress).pkScript
    const pv = (await player.w.getVtxos()).find((v) => v.value >= BET)
    if (!pv) throw new Error('no player VTXO >= BET')
    const change = pv.value - BET
    const outs: { script: Uint8Array; amount: bigint }[] = [{ script: escrowPk, amount: BigInt(BET) }]
    if (change > 0) outs.push({ script: ArkAddress.decode(playerChangeAddress).pkScript, amount: BigInt(change) })
    const escrowTx = buildOffchainTx(
      [{ txid: pv.txid, vout: pv.vout, value: pv.value, tapLeafScript: pv.forfeitTapLeafScript, tapTree: pv.tapTree }],
      outs, serverUnroll,
    )
    const signed = await player.id.sign(escrowTx.arkTx, [0])
    const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(signed.toPSBT()), escrowTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const finals: string[] = []
    for (const c of signedCheckpointTxs) {
      const cptx = Transaction.fromPSBT(base64.decode(c))
      const idx = Array.from({ length: cptx.inputsLength }, (_, i) => i)
      finals.push(base64.encode((await player.id.sign(cptx, idx)).toPSBT()))
    }
    await arkProvider.finalizeTx(arkTxid, finals)
    const playerEscrow = { txid: arkTxid, vout: 0, value: BET }

    // Reveal + resolve (server settles via the covenant — no client signing).
    const commit = await postJson<CommitResp>(`/game/${play.gameId}/commit`, {
      playerSecretHex: hex.encode(secret), playerEscrow,
    })

    // The server-settled winner MUST match the off-chain odds math on the
    // revealed secret lengths.
    const houseSecret = hex.decode(commit.houseSecret)
    const playerSecret = hex.decode(commit.playerSecret)
    const expectRole = determineVariableWinner(houseSecret, playerSecret, n, target, lo)
    const expectWinner = expectRole === 'creator' ? 'house' : 'player'
    expect(commit.winner).toBe(expectWinner)
    expect(commit.payout).toBe(2 * BET)
    expect(typeof commit.txid).toBe('string')
    console.log(
      `[variable-odds] n=${n} [${lo},${target}) digits(h=${houseSecret.length - VARIABLE_ODDS_BASE_LEN},` +
      `p=${playerSecret.length - VARIABLE_ODDS_BASE_LEN}) roll=${commit.roll} → ${commit.winner}`,
    )
  }

  it('settles variable-odds games consistently with the odds math (several configs)', async () => {
    if (!ready) return
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await makePlayerWallet(playerId)
    // Fund generously so several games run off one wallet.
    await faucet(await playerW.getBoardingAddress(), PLAYER_FUND_BTC)
    await waitFor(playerW, 'boarding', PLAYER_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(playerW)
    await waitFor(playerW, 'settled', BET * 5)

    // [n, target, lo]: a low-threshold, a shifted "roll N+" range, and the coin.
    const configs: Array<[number, number, number]> = [
      [6, 3, 0],
      [6, 6, 3],
      [2, 1, 0],
    ]
    for (const [n, target, lo] of configs) {
      await playOne({ id: playerId, w: playerW }, n, target, lo)
      await sleep(1500)
    }
  }, 600_000)
})
