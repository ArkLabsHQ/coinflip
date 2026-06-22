/**
 * v4 Phase 2 SPIKE PROBE — does the staged-forfeit contest work end-to-end?
 *
 * Co-fund a pot, then exercise the contest:
 *   Stage 1: playerReveal — spend the pot via the ConditionMultisig leaf
 *            (publishing the player's secret), pot -> StageTwo covenant, via emulator.
 *   Stage 2a: houseSettle — the house settles StageTwo to the actual winner, via emulator.
 *   Stage 2b: playerTakeAll — after settleWindow (CSV), the player sweeps StageTwo, via emulator.
 *
 * This is the empirical gate (Phase 1 taught us arkd/emulator behaviour can't be
 * assumed): if the emulator accepts the playerReveal + settles StageTwo and the
 * CSV takeAll clears, the contest covenant works and the integration can be built.
 */
import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import {
  CoinflipJointPotScript, determineWinnerV3,
  buildPlayerRevealTx, buildStageTwoSettleTx, buildStageTwoTakeAllTx, encodeSettleForEmulator,
} from 'arkade-coinflip'
import {
  Wallet, SingleKey, RestArkProvider, RestIndexerProvider, InMemoryWalletRepository,
  InMemoryContractRepository, decodeTapscript, buildOffchainTx, CSVMultisigTapscript,
  Transaction, ArkAddress, type ArkInfo, type ArkProvider, type ArkTxInput,
} from '@arkade-os/sdk'
import { packets } from '@arklabshq/contract-workflows-prototype'
import { faucet, setChainTime, resetChainTime } from './helpers'

const ARK = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMU = process.env.EMULATOR_URL || 'http://localhost:7073'
const HRP = 'rark'
const BET = 1000
const FUND_BTC = 0.001
const SETTLE_WINDOW = 512n // CSV seconds (minimum 512-multiple)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
const toXOnly = (p: Uint8Array) => (p.length === 33 ? p.slice(1) : p)

async function makeWallet(id: SingleKey): Promise<Wallet> {
  return Wallet.create({
    identity: id, arkServerUrl: ARK, esploraUrl: ESPLORA,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: false,
  })
}
async function waitFor(w: Wallet, kind: 'boarding' | 'settled', min: number, t = 90_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < t) {
    const vtxos = kind === 'settled' ? await w.getVtxos() : []
    const bal = kind === 'settled' ? vtxos.reduce((s, v) => s + v.value, 0) : (await w.getBalance()).boarding?.total ?? 0
    if (bal >= min) return
    await sleep(2000)
  }
  throw new Error(`waitFor ${kind} timed out`)
}
async function settleRetry(w: Wallet, tries = 6): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await w.settle(); return } catch (e) {
      if (!String(e).includes('No inputs found') || i === tries - 1) throw e
      await sleep(5000)
    }
  }
}
async function fund(w: Wallet): Promise<void> {
  await faucet(await w.getBoardingAddress(), FUND_BTC)
  await waitFor(w, 'boarding', BET); await settleRetry(w); await waitFor(w, 'settled', BET)
}
function input(v: { txid: string; vout: number; value: number; forfeitTapLeafScript: unknown; tapTree: Uint8Array }): ArkTxInput {
  return { txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript as ArkTxInput['tapLeafScript'], tapTree: v.tapTree }
}

describe('v4 Phase 2 spike: staged-forfeit contest', () => {
  let arkAvailable = false
  let arkProvider: ArkProvider
  let arkInfo: ArkInfo
  let serverUnroll: CSVMultisigTapscript.Type
  let emuPubkey: Uint8Array
  beforeAll(async () => {
    try {
      arkProvider = new RestArkProvider(ARK)
      arkInfo = await arkProvider.getInfo()
      serverUnroll = decodeTapscript(hex.decode(arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
      const info = await (await fetch(`${EMU}/v1/info`)).json() as { signerPubkey: string }
      emuPubkey = hex.decode(info.signerPubkey)
      arkAvailable = !!arkInfo?.signerPubkey && !!emuPubkey
    } catch { arkAvailable = false }
  }, 25_000)
  afterAll(() => resetChainTime())

  // POST a built (unsigned-by-operator) covenant tx to the emulator, retry transient lag.
  async function postEmu(built: { arkTx: Transaction; checkpoints: Transaction[] }, label: string): Promise<string> {
    const body = JSON.stringify(encodeSettleForEmulator(built))
    for (let a = 0; a < 12; a++) {
      const r = await fetch(`${EMU}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(25_000) })
      if (r.ok) return Transaction.fromPSBT(base64.decode((await r.json() as { signedArkTx: string }).signedArkTx)).id
      const text = await r.text()
      if (!(r.status >= 500 && /not found|VTXO_NOT_FOUND|failed to process/i.test(text)) || a === 11) {
        throw new Error(`emulator rejected ${label}: ${r.status} ${text}`)
      }
      await sleep(600 + a * 600)
    }
    throw new Error(`${label}: exhausted retries`)
  }

  // Co-fund a fresh pot; player chosen to WIN (dP=dC=0 -> roll 0). Returns the pot + outpoint.
  async function cofundPot(): Promise<{
    pot: CoinflipJointPotScript; cofundTxid: string; playerId: SingleKey
    playerPayout: Uint8Array; housePayout: Uint8Array
    playerRevealBytes: Uint8Array; creatorRevealBytes: Uint8Array; winner: 'player' | 'creator'
  }> {
    const playerId = SingleKey.fromRandomBytes()
    const houseId = SingleKey.fromRandomBytes()
    const playerW = await makeWallet(playerId)
    const houseW = await makeWallet(houseId)
    await fund(playerW); await fund(houseW)
    const playerPub = await playerId.xOnlyPublicKey()
    const housePub = await houseId.xOnlyPublicKey()
    const serverPub = toXOnly(hex.decode(arkInfo.signerPubkey))
    const playerPayout = ArkAddress.decode(await playerW.getAddress()).pkScript
    const housePayout = ArkAddress.decode(await houseW.getAddress()).pkScript
    const saltP = crypto.getRandomValues(new Uint8Array(16))
    const saltC = crypto.getRandomValues(new Uint8Array(16))
    const playerRevealBytes = packets.encodeReveal(0, saltP)
    const creatorRevealBytes = packets.encodeReveal(0, saltC)
    const winner = determineWinnerV3({ digit: 0, salt: saltC }, { digit: 0, salt: saltP }, 2, 1, 0)
    const now = Math.floor(Date.now() / 1000)
    const pot = new CoinflipJointPotScript({
      creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey: serverPub,
      creatorHash: sha(creatorRevealBytes), playerHash: sha(playerRevealBytes),
      finalExpiration: BigInt(now + 3600), cancelDelay: BigInt(now + 1800), exitDelay: 86_528n, settleWindow: SETTLE_WINDOW,
      oddsN: 2, oddsTarget: 1, oddsLo: 0, emulatorPubkey: emuPubkey,
      playerPayoutPkScript: playerPayout, housePayoutPkScript: housePayout,
      playerStake: BigInt(BET), houseStake: BigInt(BET),
    })
    const potAddr = pot.address(HRP, serverPub).pkScript
    const pv = (await playerW.getVtxos())[0]
    const hv = (await houseW.getVtxos())[0]
    const cofund = buildOffchainTx([input(pv), input(hv)], [
      { script: potAddr, amount: BigInt(2 * BET) },
      { script: playerPayout, amount: BigInt(pv.value - BET) },
      { script: housePayout, amount: BigInt(hv.value - BET) },
    ], serverUnroll)
    let cofundSigned = await playerId.sign(cofund.arkTx, [0])
    cofundSigned = await houseId.sign(cofundSigned, [1])
    const { arkTxid: cofundTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(cofundSigned.toPSBT()), cofund.checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const finals: string[] = []
    for (let i = 0; i < signedCheckpointTxs.length; i++) {
      const tx = Transaction.fromPSBT(base64.decode(signedCheckpointTxs[i]))
      const owner = i === 0 ? playerId : houseId
      let s = tx
      try { s = await owner.sign(tx, Array.from({ length: tx.inputsLength }, (_, k) => k)) }
      catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
      finals.push(base64.encode(s.toPSBT()))
    }
    await arkProvider.finalizeTx(cofundTxid, finals)
    return { pot, cofundTxid, playerId, playerPayout, housePayout, playerRevealBytes, creatorRevealBytes, winner }
  }

  // Stage 1: player publishes the secret, pot -> StageTwo. Returns the StageTwo txid.
  async function stageOneReveal(g: Awaited<ReturnType<typeof cofundPot>>): Promise<string> {
    const reveal = buildPlayerRevealTx({
      pot: g.pot, cofund: { txid: g.cofundTxid, vout: 0, value: 2 * BET },
      playerRevealBytes: g.playerRevealBytes, serverUnroll,
    })
    const arkTxSigned = await g.playerId.sign(reveal.arkTx, [0])
    const cps = await Promise.all(reveal.checkpoints.map(async (c) => {
      let s = c
      try { s = await g.playerId.sign(c, Array.from({ length: c.inputsLength }, (_, k) => k)) }
      catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
      return s
    }))
    return postEmu({ arkTx: arkTxSigned, checkpoints: cps }, 'playerReveal')
  }

  async function vtxoLanded(scriptPk: Uint8Array, txid: string, value: number): Promise<boolean> {
    const indexer = new RestIndexerProvider(ARK)
    for (let i = 0; i < 25; i++) {
      const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(scriptPk)] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (vtxos.some((v: any) => v.txid === txid && v.value === value)) return true
      await sleep(1000)
    }
    return false
  }

  it('stage 1 reveal -> stage 2 HOUSE SETTLE pays the winner', async () => {
    if (!arkAvailable) { console.warn('ark/emu unavailable — skipped'); return }
    const g = await cofundPot()
    const stageTwoTxid = await stageOneReveal(g)
    console.log('[v4-staged] stage 1: pot -> StageTwo', stageTwoTxid)

    // The pot now sits in the StageTwo covenant at {stageTwoTxid, 0}.
    expect(await vtxoLanded(g.pot.stageTwo.pkScript, stageTwoTxid, 2 * BET)).toBe(true)

    // Stage 2a: the house settles to the actual winner.
    const settle = buildStageTwoSettleTx({
      stageTwo: g.pot.stageTwo, stageTwoOutpoint: { txid: stageTwoTxid, vout: 0, value: 2 * BET },
      winner: g.winner, winnerPayoutPkScript: g.winner === 'player' ? g.playerPayout : g.housePayout,
      potAmount: BigInt(2 * BET), playerRevealBytes: g.playerRevealBytes, creatorRevealBytes: g.creatorRevealBytes, serverUnroll,
    })
    const settleTxid = await postEmu(settle, 'stageTwoSettle')
    console.log('[v4-staged] stage 2a: house settled to', g.winner, settleTxid)
    expect(await vtxoLanded(g.winner === 'player' ? g.playerPayout : g.housePayout, settleTxid, 2 * BET)).toBe(true)
  }, 300_000)

  it('stage 1 reveal -> stage 2 PLAYER TAKE-ALL after settleWindow', async () => {
    if (!arkAvailable) { console.warn('ark/emu unavailable — skipped'); return }
    const g = await cofundPot()
    const stageTwoTxid = await stageOneReveal(g)
    console.log('[v4-staged] stage 1: pot -> StageTwo', stageTwoTxid)
    expect(await vtxoLanded(g.pot.stageTwo.pkScript, stageTwoTxid, 2 * BET)).toBe(true)

    // The house stalls; past settleWindow the player sweeps the whole pot.
    await setChainTime(Math.floor(Date.now() / 1000) + Number(SETTLE_WINDOW) + 120, 14)
    const takeAll = buildStageTwoTakeAllTx({
      stageTwo: g.pot.stageTwo, stageTwoOutpoint: { txid: stageTwoTxid, vout: 0, value: 2 * BET },
      playerPayoutPkScript: g.playerPayout, potAmount: BigInt(2 * BET), serverUnroll,
    })
    const takeAllTxid = await postEmu(takeAll, 'stageTwoTakeAll')
    console.log('[v4-staged] stage 2b: player swept the whole pot', takeAllTxid)
    expect(await vtxoLanded(g.playerPayout, takeAllTxid, 2 * BET)).toBe(true)
  }, 300_000)
})
