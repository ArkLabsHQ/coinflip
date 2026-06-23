/**
 * v4 server /play e2e — boots the server deps against arkade-regtest, funds the
 * house, and exercises handleV4Play (Phase 3, endpoint 1).
 *
 * /play does setup only (no signing): reserve a house stake VTXO, derive the
 * joint-pot covenant, persist the game, return the covenant params. The headline
 * assertion re-derives the CoinflipJointPotScript CLIENT-SIDE from the returned
 * params and confirms the pot address is byte-identical — i.e. the client and
 * server agree on the covenant, which is what makes the later co-fund spendable.
 */
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { base64, hex } from '@scure/base'
import {
  SingleKey, Wallet, InMemoryWalletRepository, InMemoryContractRepository,
  decodeTapscript, CSVMultisigTapscript, RestIndexerProvider, Transaction, ArkAddress, buildOffchainTx, type ArkTxInput,
} from '@arkade-os/sdk'
import { CoinflipJointPotScript, buildCofundFromPlay, buildPlayerRevealTx, buildStageTwoTakeAllTx, determineWinnerV3 } from 'arkade-coinflip'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { packets } = require('@arklabshq/contract-workflows-prototype')
import { faucet, settleWithRetry, setChainTime, resetChainTime } from './helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toInput = (v: any): ArkTxInput => ({ txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript, tapTree: v.tapTree })

/** Split a wallet's largest VTXO into `count` ~equal pieces (sums exactly, no
 *  fee gap) so a co-fund can be forced to use multiple player inputs. */
async function splitEqual(w: Wallet, id: SingleKey, count: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const big = (await w.getVtxos()).sort((a: any, b: any) => b.value - a.value)[0]
  const piece = Math.floor(big.value / count)
  const selfPk = ArkAddress.decode(await w.getAddress()).pkScript
  const unroll = decodeTapscript(hex.decode((await w.arkProvider.getInfo()).checkpointTapscript)) as CSVMultisigTapscript.Type
  const outs = Array.from({ length: count }, (_, i) => ({ script: selfPk, amount: BigInt(i === 0 ? big.value - piece * (count - 1) : piece) }))
  const { arkTx, checkpoints } = buildOffchainTx([toInput(big)], outs, unroll)
  const signed = await id.sign(arkTx, [0])
  const { arkTxid, signedCheckpointTxs } = await w.arkProvider.submitTx(base64.encode(signed.toPSBT()), checkpoints.map((c) => base64.encode(c.toPSBT())))
  const finals: string[] = []
  for (const c of signedCheckpointTxs) {
    const tx = Transaction.fromPSBT(base64.decode(c))
    let s = tx
    try { s = await id.sign(tx, Array.from({ length: tx.inputsLength }, (_, i) => i)) } catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
    finals.push(base64.encode(s.toPSBT()))
  }
  await w.arkProvider.finalizeTx(arkTxid, finals)
}

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMULATOR_URL = process.env.EMULATOR_URL || 'http://localhost:7073'
const HOUSE_FUND_BTC = 0.005
const BET = 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)

async function waitForBoarding(w: Wallet, min: number, t = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < t) { if ((await w.getBalance()).boarding.total >= min) return; await sleep(2000) }
  throw new Error('Timeout waiting for boarding balance')
}
async function waitForSettled(w: Wallet, min: number, t = 90_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < t) { if ((await w.getBalance()).settled >= min) return; await sleep(2000) }
  throw new Error('Timeout waiting for settled balance')
}

let arkAvailable = false
beforeAll(async () => {
  try { arkAvailable = (await fetch(`${ARK_SERVER_URL}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok } catch { arkAvailable = false }
}, 10_000)

// Spending freshly-built PRECONFIRMED VTXOs in the co-fund hits a known ~13%
// transient arkd race (characterized in v4-scale.test.ts; the scale harness
// handles it with retry-fresh-inputs). Each test here uses fresh identities, so
// a bounded retry — a fully fresh attempt — clears the transient. This is the
// real arkd behaviour, not a logic flake: every test passes in isolation.
jest.retryTimes(2, { logErrorsBeforeRetry: true })

describe('v4 server: handleV4Play', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deps: any
  let dataDir: string
  let app: express.Express

  beforeAll(async () => {
    if (!arkAvailable) return
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinflip-v4-test-'))
    process.env.DATA_DIR = dataDir
    process.env.ARK_SERVER_URL = ARK_SERVER_URL
    process.env.ESPLORA_URL = ESPLORA_URL
    process.env.EMULATOR_URL = EMULATOR_URL

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    server = require('arkade-coinflip-server')
    deps = await server.bootstrapDeps({ walletSettlementConfig: false })

    await faucet(await deps.wallet.getBoardingAddress(), HOUSE_FUND_BTC)
    await waitForBoarding(deps.wallet, HOUSE_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(deps.wallet)
    await waitForSettled(deps.wallet, BET * 5)
    // Fragment into a small pool — v4 spends a WHOLE house VTXO per game, so each
    // game needs its own free stake input (one big VTXO would go "house busy").
    await server.ensureHouseVtxoPool(deps, { targetCount: 8, pieceSize: BET * 5 })

    app = express()
    app.use(express.json())
    app.use(server.createV4Routes(deps))
  }, 180_000)

  afterAll(() => {
    // The forfeit-recovery test advances chain time via setmocktime; restore it
    // so the shared regtest stays usable for other suites / dev.
    resetChainTime()
    if (dataDir && fs.existsSync(dataDir)) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('reserves a house VTXO + returns covenant params the client re-derives to the same pot address', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    // Player identity + addresses (no funding needed for /play).
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await Wallet.create({
      identity: playerId, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const playerReveal = packets.encodeReveal(0, salt)
    const playerHash = createHash('sha256').update(playerReveal).digest('hex')

    const res = await server.handleV4Play({
      tier: BET,
      playerPubkey: hex.encode(toXOnly(await playerId.compressedPublicKey())),
      playerHash,
      playerPayoutAddress: await playerW.getAddress(),
      playerChangeAddress: await playerW.getAddress(),
    }, deps)

    // Shape + economics.
    expect(typeof res.gameId).toBe('string')
    expect(res.pot).toBe(2 * BET)
    expect(res.betAmount).toBe(BET)
    expect(res.houseStake).toBe(BET) // coin: house stakes the tier
    expect(Array.isArray(res.houseInputs)).toBe(true)
    expect(res.houseInputs.length).toBeGreaterThanOrEqual(1)
    expect(res.houseInputs.reduce((s: number, h: { value: number }) => s + h.value, 0)).toBeGreaterThanOrEqual(BET)
    expect(typeof res.houseInputs[0].txid).toBe('string')
    expect(res.potAddress.startsWith(res.networkHrp)).toBe(true)

    // Headline: re-derive the covenant client-side → byte-identical pot address.
    const cv = res.covenant
    const rebuilt = new CoinflipJointPotScript({
      creatorPubkey: hex.decode(cv.creatorPubkey),
      playerPubkey: hex.decode(cv.playerPubkey),
      serverPubkey: hex.decode(cv.serverPubkey),
      creatorHash: hex.decode(cv.creatorHash),
      playerHash: hex.decode(cv.playerHash),
      finalExpiration: BigInt(cv.finalExpiration), cancelDelay: BigInt(cv.cancelDelay),
      exitDelay: BigInt(cv.exitDelay),
      oddsN: cv.oddsN, oddsTarget: cv.oddsTarget, oddsLo: cv.oddsLo,
      emulatorPubkey: hex.decode(cv.emulatorPubkey),
      playerPayoutPkScript: hex.decode(cv.playerPayoutPkScript),
      housePayoutPkScript: hex.decode(cv.housePayoutPkScript),
      playerStake: BigInt(cv.playerStake), houseStake: BigInt(cv.houseStake),
    })
    expect(rebuilt.address(res.networkHrp, hex.decode(cv.serverPubkey)).encode()).toBe(res.potAddress)

    // The game persisted and shows up as pending for the player.
    const pending = await deps.repos.games.countPendingForPlayer(res.covenant.playerPubkey)
    expect(pending).toBeGreaterThanOrEqual(1)

    console.log('[v4-play] gameId', res.gameId, '→ pot', res.potAddress, '(', res.pot, 'sats )')
  }, 120_000)

  it('POST /api/v4/play via the route layer (express wiring + validation)', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await Wallet.create({
      identity: playerId, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    const playerHash = createHash('sha256').update(packets.encodeReveal(0, crypto.getRandomValues(new Uint8Array(16)))).digest('hex')
    const addr = await playerW.getAddress()

    // Missing required fields → 400.
    await request(app).post('/api/v4/play').send({ tier: BET }).expect(400)

    // Full play → 200 with covenant params.
    const res = await request(app).post('/api/v4/play').send({
      tier: BET,
      playerPubkey: hex.encode(toXOnly(await playerId.compressedPublicKey())),
      playerHash, playerPayoutAddress: addr, playerChangeAddress: addr,
    }).expect(200)
    expect(res.body.pot).toBe(2 * BET)
    expect(typeof res.body.potAddress).toBe('string')
    expect(res.body.potAddress.startsWith(res.body.networkHrp)).toBe(true)
    expect(res.body.covenant).toBeDefined()
    expect(res.body.houseInputs.length).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('co-funds via the 2-round handshake, then reveal settles the pot to the winner', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    // Fund a player (provides the player stake input).
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await Wallet.create({
      identity: playerId, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    await faucet(await playerW.getBoardingAddress(), 0.001)
    await waitForBoarding(playerW, BET)
    await settleWithRetry(playerW)
    await waitForSettled(playerW, BET)

    const salt = crypto.getRandomValues(new Uint8Array(16))
    const playerReveal = packets.encodeReveal(0, salt)
    const playerHash = createHash('sha256').update(playerReveal).digest('hex')
    const res = await server.handleV4Play({
      tier: BET,
      playerPubkey: hex.encode(toXOnly(await playerId.compressedPublicKey())),
      playerHash,
      playerPayoutAddress: await playerW.getAddress(),
      playerChangeAddress: await playerW.getAddress(),
    }, deps)

    // Client builds the co-fund entirely from public data via the lib primitive:
    // player inputs = the client's own funded VTXO(s); house inputs rebuilt from
    // the /play response (houseInputs). serverUnroll = arkd's public info.
    const pv = (await playerW.getVtxos())[0]
    const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
    const cf = buildCofundFromPlay({
      play: res,
      playerInputs: [toInput(pv)],
      playerChangePkScript: ArkAddress.decode(await playerW.getAddress()).pkScript,
      betAmount: BET,
      serverUnroll,
    })
    const arkTxPlayerSigned = await playerId.sign(cf.arkTx, [0])

    // Round 1: /cofund — server signs the house inputs + checkpoints, returns ours.
    const cofundRes = await server.handleV4Cofund(res.gameId, {
      arkTx: base64.encode(arkTxPlayerSigned.toPSBT()),
      checkpoints: cf.checkpoints.map((c: Transaction) => base64.encode(c.toPSBT())),
    }, deps)
    expect(typeof cofundRes.arkTxid).toBe('string')

    // Client signs its checkpoints (the leading k).
    const signedPlayerCheckpoints = await Promise.all(cofundRes.playerCheckpoints.map(async (b64: string) => {
      const cp = Transaction.fromPSBT(base64.decode(b64))
      let s = cp
      try { s = await playerId.sign(cp, Array.from({ length: cp.inputsLength }, (_, i) => i)) }
      catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
      return base64.encode(s.toPSBT())
    }))

    // Round 2: /cofund-finalize — server finalizes → pot VTXO created.
    const finRes = await server.handleV4CofundFinalize(res.gameId, {
      playerCheckpoints: signedPlayerCheckpoints,
    }, deps)
    expect(finRes.cofundTxid).toBe(cofundRes.arkTxid)
    expect(finRes.potOutpoint.value).toBe(2 * BET)

    // The joint-pot VTXO is live on-chain.
    const indexer = new RestIndexerProvider(ARK_SERVER_URL)
    const potPk = hex.encode(ArkAddress.decode(res.potAddress).pkScript)
    let found = false
    for (let i = 0; i < 20 && !found; i++) {
      const { vtxos } = await indexer.getVtxos({ scripts: [potPk] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (vtxos.some((x: any) => x.txid === finRes.cofundTxid && x.value === 2 * BET)) found = true
      else await sleep(1000)
    }
    expect(found).toBe(true)
    console.log('[v4-cofund] pot VTXO live:', finRes.cofundTxid, ':0 =', finRes.potOutpoint.value, 'sats')

    // ── Reveal → settle the whole pot to the winner ──
    const revealRes = await server.handleV4Reveal(res.gameId, { playerSecretHex: hex.encode(playerReveal) }, deps)
    expect(['player', 'house']).toContain(revealRes.winner)
    expect(typeof revealRes.settleTxid).toBe('string')
    expect(revealRes.payout).toBe(2 * BET)

    // The pot is swept to the winner's payout address.
    const winnerAddr = revealRes.winner === 'player' ? await playerW.getAddress() : await deps.wallet.getAddress()
    const winnerPk = hex.encode(ArkAddress.decode(winnerAddr).pkScript)
    let settled = false
    for (let i = 0; i < 20 && !settled; i++) {
      const { vtxos } = await indexer.getVtxos({ scripts: [winnerPk] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (vtxos.some((x: any) => x.txid === revealRes.settleTxid && x.value === 2 * BET)) settled = true
      else await sleep(1000)
    }
    expect(settled).toBe(true)
    console.log('[v4-reveal] winner', revealRes.winner, '→ settled', revealRes.settleTxid, '(', revealRes.payout, 'sats )')
  }, 300_000)

  it('co-funds from MULTIPLE player inputs (no single VTXO ≥ tier) → settles', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    // Fund a player, then split into sub-tier pieces so the co-fund MUST use 2+.
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await Wallet.create({
      identity: playerId, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    await faucet(await playerW.getBoardingAddress(), 0.0001) // 10_000 sats
    await waitForBoarding(playerW, 8000)
    await settleWithRetry(playerW)
    await waitForSettled(playerW, 8000)
    await splitEqual(playerW, playerId, 12) // ~825-sat pieces, each < BET (1000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pieces: any[] = []
    for (let i = 0; i < 30; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pieces = (await playerW.getVtxos()).filter((v: any) => v.value < BET)
      if (pieces.length >= 2) break
      await sleep(1000)
    }
    expect(pieces.length).toBeGreaterThanOrEqual(2)

    const salt = crypto.getRandomValues(new Uint8Array(16))
    const playerReveal = packets.encodeReveal(0, salt)
    const playerHash = createHash('sha256').update(playerReveal).digest('hex')
    const addr = await playerW.getAddress()
    const res = await server.handleV4Play({
      tier: BET, playerPubkey: hex.encode(toXOnly(await playerId.compressedPublicKey())),
      playerHash, playerPayoutAddress: addr, playerChangeAddress: addr,
    }, deps)

    // Pick sub-tier VTXOs largest-first until ≥ tier — guaranteed ≥ 2 here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const picked: any[] = []
    let sum = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const v of pieces.sort((a: any, b: any) => b.value - a.value)) {
      if (sum >= BET) break
      picked.push(v); sum += v.value
    }
    expect(picked.length).toBeGreaterThanOrEqual(2) // FORCED multi player-input

    const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
    const cf = buildCofundFromPlay({
      play: res, playerInputs: picked.map(toInput),
      playerChangePkScript: ArkAddress.decode(addr).pkScript, betAmount: BET, serverUnroll,
    })
    const k = picked.length
    expect(cf.arkTx.inputsLength).toBe(k + res.houseInputs.length)

    const arkTxSigned = await playerId.sign(cf.arkTx, Array.from({ length: k }, (_, i) => i))
    const cofundRes = await server.handleV4Cofund(res.gameId, {
      arkTx: base64.encode(arkTxSigned.toPSBT()),
      checkpoints: cf.checkpoints.map((c: Transaction) => base64.encode(c.toPSBT())),
    }, deps)
    expect(cofundRes.playerCheckpoints.length).toBe(k) // the server returned k player checkpoints

    const signedCps = await Promise.all(cofundRes.playerCheckpoints.map(async (b64: string) => {
      const cp = Transaction.fromPSBT(base64.decode(b64))
      let s = cp
      try { s = await playerId.sign(cp, Array.from({ length: cp.inputsLength }, (_, i) => i)) }
      catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
      return base64.encode(s.toPSBT())
    }))
    const finRes = await server.handleV4CofundFinalize(res.gameId, { playerCheckpoints: signedCps }, deps)
    expect(finRes.potOutpoint.value).toBe(2 * BET)

    // Pot landed on-chain + reveal settles it.
    const indexer2 = new RestIndexerProvider(ARK_SERVER_URL)
    const potPk = hex.encode(ArkAddress.decode(res.potAddress).pkScript)
    let found = false
    for (let i = 0; i < 20 && !found; i++) {
      const { vtxos } = await indexer2.getVtxos({ scripts: [potPk] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (vtxos.some((x: any) => x.txid === finRes.cofundTxid && x.value === 2 * BET)) found = true
      else await sleep(1000)
    }
    expect(found).toBe(true)
    const revealRes = await server.handleV4Reveal(res.gameId, { playerSecretHex: hex.encode(playerReveal) }, deps)
    expect(['player', 'house']).toContain(revealRes.winner)
    console.log(`[v4-multi] ${k} player inputs + ${res.houseInputs.length} house input(s) → pot ${finRes.cofundTxid} → ${revealRes.winner} settled ${revealRes.settleTxid}`)
  }, 300_000)

  it('plays a FULL game over the real /api/v4 HTTP routes (play→cofund→finalize→reveal)', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    // This drives the exact HTTP calls the client's api.ts wrappers make — the
    // closest play-test to the browser flow without the Vue layer (the signing
    // uses the same SDK identity as the client).
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await Wallet.create({
      identity: playerId, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    await faucet(await playerW.getBoardingAddress(), 0.001)
    await waitForBoarding(playerW, BET)
    await settleWithRetry(playerW)
    await waitForSettled(playerW, BET)

    const salt = crypto.getRandomValues(new Uint8Array(16))
    const playerReveal = packets.encodeReveal(0, salt)
    const playerHash = createHash('sha256').update(playerReveal).digest('hex')
    const addr = await playerW.getAddress()

    // 1. POST /api/v4/play
    const play = (await request(app).post('/api/v4/play').send({
      tier: BET, playerPubkey: hex.encode(toXOnly(await playerId.compressedPublicKey())),
      playerHash, playerPayoutAddress: addr, playerChangeAddress: addr,
    }).expect(200)).body

    // 2. Client builds + signs the co-fund from the HTTP response.
    const pv = (await playerW.getVtxos())[0]
    const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
    const cf = buildCofundFromPlay({
      play, playerInputs: [toInput(pv)],
      playerChangePkScript: ArkAddress.decode(addr).pkScript, betAmount: BET, serverUnroll,
    })
    const arkTxSigned = await playerId.sign(cf.arkTx, [0])

    // 3. POST /api/v4/game/:id/cofund
    const cofund = (await request(app).post(`/api/v4/game/${play.gameId}/cofund`).send({
      arkTx: base64.encode(arkTxSigned.toPSBT()),
      checkpoints: cf.checkpoints.map((c: Transaction) => base64.encode(c.toPSBT())),
    }).expect(200)).body

    // 4. Sign the returned player checkpoints, POST /api/v4/game/:id/cofund-finalize
    const signedCps = await Promise.all(cofund.playerCheckpoints.map(async (b64: string) => {
      const cp = Transaction.fromPSBT(base64.decode(b64))
      let s = cp
      try { s = await playerId.sign(cp, Array.from({ length: cp.inputsLength }, (_, i) => i)) }
      catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
      return base64.encode(s.toPSBT())
    }))
    const fin = (await request(app).post(`/api/v4/game/${play.gameId}/cofund-finalize`)
      .send({ playerCheckpoints: signedCps }).expect(200)).body
    expect(fin.potOutpoint.value).toBe(2 * BET)

    // 5. POST /api/v4/game/:id/reveal
    const reveal = (await request(app).post(`/api/v4/game/${play.gameId}/reveal`)
      .send({ playerSecretHex: hex.encode(playerReveal) }).expect(200)).body
    expect(['player', 'house']).toContain(reveal.winner)
    expect(reveal.payout).toBe(2 * BET)
    console.log('[v4-http] full game over HTTP →', reveal.winner, 'settled', reveal.settleTxid)
  }, 240_000)

  it('house RECLAIMS its stake via the covenant-only refund when the player never reveals', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    // Co-fund a pot exactly like the happy path — but the player never reveals.
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await Wallet.create({
      identity: playerId, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    await faucet(await playerW.getBoardingAddress(), 0.001)
    await waitForBoarding(playerW, BET)
    await settleWithRetry(playerW)
    await waitForSettled(playerW, BET)

    const salt = crypto.getRandomValues(new Uint8Array(16))
    const playerHash = createHash('sha256').update(packets.encodeReveal(0, salt)).digest('hex')
    const playerAddr = await playerW.getAddress()
    const res = await server.handleV4Play({
      tier: BET, playerPubkey: hex.encode(toXOnly(await playerId.compressedPublicKey())),
      playerHash, playerPayoutAddress: playerAddr, playerChangeAddress: playerAddr,
    }, deps)
    const cv = res.covenant

    const pv = (await playerW.getVtxos())[0]
    const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
    const cf = buildCofundFromPlay({
      play: res, playerInputs: [toInput(pv)],
      playerChangePkScript: ArkAddress.decode(playerAddr).pkScript, betAmount: BET, serverUnroll,
    })
    const arkTxPlayerSigned = await playerId.sign(cf.arkTx, [0])
    const cofundRes = await server.handleV4Cofund(res.gameId, {
      arkTx: base64.encode(arkTxPlayerSigned.toPSBT()),
      checkpoints: cf.checkpoints.map((c: Transaction) => base64.encode(c.toPSBT())),
    }, deps)
    const signedCps = await Promise.all(cofundRes.playerCheckpoints.map(async (b64: string) => {
      const cp = Transaction.fromPSBT(base64.decode(b64))
      let s = cp
      try { s = await playerId.sign(cp, Array.from({ length: cp.inputsLength }, (_, i) => i)) }
      catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
      return base64.encode(s.toPSBT())
    }))
    const finRes = await server.handleV4CofundFinalize(res.gameId, { playerCheckpoints: signedCps }, deps)
    expect(finRes.potOutpoint.value).toBe(2 * BET)

    // The player NEVER reveals. Past cancelDelay the house's failsafe poll
    // (reconcileV4Refunds — the same loop startV4RefundTimer fires) finds the
    // stalled game and broadcasts the refund: a COVENANT-ONLY spend (no
    // pre-signing) — the emulator enforces the exact split and co-signs, arkd
    // co-signs the server slot after the CLTV. This claws the house stake back
    // AND returns the player's, BEFORE the player's forfeit (finalExpiration >
    // cancelDelay) opens. Advance the chain's MTP past cancelDelay first (arkd
    // rejects the CLTV spend until then).
    await setChainTime(cv.cancelDelay + 60, 14)
    // The Ark server's chain-tip view lags bitcoind right after mining;
    // reconcileV4Refunds gates on getChainTip().time, so wait for arkd to INDEX the
    // advanced tip before reconciling. Otherwise the gate skips this game (the only
    // pending one in CI's fresh DB), the broadcast never fires, and we'd be relying
    // on flaky retries — the actual cause of the CI flake. Once the tip is indexed
    // past cancelDelay, MTP is too, so arkd accepts the covenant refund's CLTV.
    for (let i = 0; i < 60; i++) {
      if ((await deps.wallet.onchainProvider.getChainTip()).time > cv.cancelDelay) break
      await sleep(1000)
    }
    const refundTxids = await server.reconcileV4Refunds(deps)
    expect(refundTxids.length).toBeGreaterThanOrEqual(1)
    const refundTxid = refundTxids[0]

    // Split-back: the player got back EXACTLY their stake (BET) — NOT the whole
    // pot, so the forfeit grief is pre-empted — and the house got its stake back.
    const indexer = new RestIndexerProvider(ARK_SERVER_URL)
    const playerPk = hex.encode(ArkAddress.decode(playerAddr).pkScript)
    const housePk = hex.encode(ArkAddress.decode(await deps.wallet.getAddress()).pkScript)
    let playerBack = false
    let houseBack = false
    for (let i = 0; i < 20 && !(playerBack && houseBack); i++) {
      const [pRes, hRes] = await Promise.all([
        indexer.getVtxos({ scripts: [playerPk] }),
        indexer.getVtxos({ scripts: [housePk] }),
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (pRes.vtxos.some((v: any) => v.txid === refundTxid && v.value === BET)) playerBack = true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (hRes.vtxos.some((v: any) => v.txid === refundTxid && v.value === BET)) houseBack = true
      if (!(playerBack && houseBack)) await sleep(1000)
    }
    expect(playerBack).toBe(true)
    expect(houseBack).toBe(true)
    console.log('[v4-refund] player never revealed → house split the pot back via the covenant-only refund:', refundTxid)
  }, 300_000)

  it('player RECOVERS the whole pot via the staged-forfeit contest when the server never settles', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    const playerId = SingleKey.fromRandomBytes()
    const playerW = await Wallet.create({
      identity: playerId, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    await faucet(await playerW.getBoardingAddress(), 0.001)
    await waitForBoarding(playerW, BET)
    await settleWithRetry(playerW)
    await waitForSettled(playerW, BET)

    const salt = crypto.getRandomValues(new Uint8Array(16))
    const playerReveal = packets.encodeReveal(0, salt)
    const playerHash = createHash('sha256').update(playerReveal).digest('hex')
    const addr = await playerW.getAddress()

    // Short forfeit window so the CLTV matures during the test.
    process.env.V4_FINAL_EXPIRATION_SECS = '10'
    const res = await server.handleV4Play({
      tier: BET, playerPubkey: hex.encode(toXOnly(await playerId.compressedPublicKey())),
      playerHash, playerPayoutAddress: addr, playerChangeAddress: addr,
    }, deps)
    delete process.env.V4_FINAL_EXPIRATION_SECS

    // Co-fund the pot — then the player will NOT reveal (server stalls).
    const pv = (await playerW.getVtxos())[0]
    const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
    const cf = buildCofundFromPlay({
      play: res, playerInputs: [toInput(pv)],
      playerChangePkScript: ArkAddress.decode(addr).pkScript, betAmount: BET, serverUnroll,
    })
    const arkTxSigned = await playerId.sign(cf.arkTx, [0])
    const cofundRes = await server.handleV4Cofund(res.gameId, {
      arkTx: base64.encode(arkTxSigned.toPSBT()),
      checkpoints: cf.checkpoints.map((c: Transaction) => base64.encode(c.toPSBT())),
    }, deps)
    const signedCps = await Promise.all(cofundRes.playerCheckpoints.map(async (b64: string) => {
      const cp = Transaction.fromPSBT(base64.decode(b64))
      let s = cp
      try { s = await playerId.sign(cp, Array.from({ length: cp.inputsLength }, (_, i) => i)) }
      catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
      return base64.encode(s.toPSBT())
    }))
    const finRes = await server.handleV4CofundFinalize(res.gameId, { playerCheckpoints: signedCps }, deps)
    expect(finRes.potOutpoint.value).toBe(2 * BET)

    // ── Server stalls (NO /reveal). The player runs the staged-forfeit contest:
    //    stage 1 publishes the player's secret on-chain (pot -> StageTwo), then
    //    after finalExpiration the player sweeps the WHOLE pot via the playerTakeAll
    //    leaf (player + arkd + emulator, no house). ──
    const cv = res.covenant
    const pot = new CoinflipJointPotScript({
      creatorPubkey: hex.decode(cv.creatorPubkey), playerPubkey: hex.decode(cv.playerPubkey),
      serverPubkey: hex.decode(cv.serverPubkey), creatorHash: hex.decode(cv.creatorHash),
      playerHash: hex.decode(cv.playerHash), finalExpiration: BigInt(cv.finalExpiration), cancelDelay: BigInt(cv.cancelDelay),
      exitDelay: BigInt(cv.exitDelay), oddsN: cv.oddsN, oddsTarget: cv.oddsTarget, oddsLo: cv.oddsLo,
      emulatorPubkey: hex.decode(cv.emulatorPubkey), playerPayoutPkScript: hex.decode(cv.playerPayoutPkScript),
      housePayoutPkScript: hex.decode(cv.housePayoutPkScript), playerStake: BigInt(cv.playerStake), houseStake: BigInt(cv.houseStake),
    })
    const playerPkScript = ArkAddress.decode(addr).pkScript
    const indexer3 = new RestIndexerProvider(ARK_SERVER_URL)

    // Player-sign (arkTx vin 0 + each checkpoint) a covenant spend whose leaf
    // includes the player, then POST to the emulator; returns the new txid.
    const signAndPostEmu = async (built: { arkTx: Transaction; checkpoints: Transaction[] }, label: string): Promise<string> => {
      const arkTxSigned = await playerId.sign(built.arkTx, [0])
      const cps = await Promise.all(built.checkpoints.map(async (c) => {
        let s = c
        try { s = await playerId.sign(c, Array.from({ length: c.inputsLength }, (_, i) => i)) }
        catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
        return base64.encode(s.toPSBT())
      }))
      const body = JSON.stringify({ arkTx: base64.encode(arkTxSigned.toPSBT()), checkpointTxs: cps })
      for (let a = 0; a < 12; a++) {
        const r = await fetch(`${EMULATOR_URL}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) })
        if (r.ok) return Transaction.fromPSBT(base64.decode((await r.json() as { signedArkTx: string }).signedArkTx)).id
        const text = await r.text()
        if (!(r.status >= 500 && /not found|VTXO_NOT_FOUND|failed to process/i.test(text)) || a === 11) throw new Error(`${label} rejected: ${r.status} ${text}`)
        await sleep(700 + a * 700)
      }
      throw new Error(`${label}: retries exhausted`)
    }
    const vtxoLanded = async (pkScript: Uint8Array, txid: string): Promise<boolean> => {
      const pk = hex.encode(pkScript)
      // 60s budget (see vtxoAt): a loaded CI runner can take >20s to settle + index a VTXO.
      for (let i = 0; i < 60; i++) {
        const { vtxos } = await indexer3.getVtxos({ scripts: [pk] })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (vtxos.some((x: any) => x.txid === txid && x.value === 2 * BET)) return true
        await sleep(1000)
      }
      return false
    }

    // Stage 1: publish the player's secret on-chain — pot -> StageTwo (no timelock).
    const reveal = buildPlayerRevealTx({ pot, cofund: finRes.potOutpoint, playerRevealBytes: playerReveal, serverUnroll })
    const stageTwoTxid = await signAndPostEmu(reveal, 'playerReveal')
    expect(await vtxoLanded(pot.stageTwo.pkScript, stageTwoTxid)).toBe(true)
    console.log('[v4-forfeit] stage 1: pot -> StageTwo', stageTwoTxid)

    // Advance the chain's median-time-past beyond finalExpiration (real-time
    // waiting can't — CLTV is evaluated against MTP). NOTE: this freezes the
    // regtest clock, so this test must run isolated + the stack restarted after.
    await setChainTime(cv.finalExpiration + 60, 14)
    // Same tip-sync lag as the refund path: wait for arkd to index the advanced tip
    // past finalExpiration before the takeAll, so its CLTV is mature on the first post
    // instead of relying on a jest-level retry.
    for (let i = 0; i < 60; i++) {
      if ((await deps.wallet.onchainProvider.getChainTip()).time > cv.finalExpiration) break
      await sleep(1000)
    }

    // Stage 2: after finalExpiration, the player sweeps the WHOLE pot.
    const takeAll = buildStageTwoTakeAllTx({
      stageTwo: pot.stageTwo, stageTwoOutpoint: { txid: stageTwoTxid, vout: 0, value: 2 * BET },
      playerPayoutPkScript: playerPkScript, potAmount: BigInt(2 * BET), serverUnroll,
    })
    const claimTxid = await signAndPostEmu(takeAll, 'stageTwoTakeAll')
    expect(claimTxid).toBeTruthy()
    expect(await vtxoLanded(playerPkScript, claimTxid)).toBe(true)
    console.log('[v4-forfeit] server stalled → player swept the whole pot via staged forfeit:', claimTxid)
  }, 300_000)

  it('server stage-2 poll settles a CONTESTED game to the winner (player revealed on-chain, NO /reveal)', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    const playerId = SingleKey.fromRandomBytes()
    const playerW = await Wallet.create({
      identity: playerId, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    await faucet(await playerW.getBoardingAddress(), 0.001)
    await waitForBoarding(playerW, BET)
    await settleWithRetry(playerW)
    await waitForSettled(playerW, BET)

    const salt = crypto.getRandomValues(new Uint8Array(16))
    const playerReveal = packets.encodeReveal(0, salt)
    const playerHash = createHash('sha256').update(playerReveal).digest('hex')
    const addr = await playerW.getAddress()

    // Default finalExpiration — the houseSettle leaf has NO timelock, so the poll
    // settles the instant it detects the StageTwo VTXO (no chain advance needed).
    const res = await server.handleV4Play({
      tier: BET, playerPubkey: hex.encode(toXOnly(await playerId.compressedPublicKey())),
      playerHash, playerPayoutAddress: addr, playerChangeAddress: addr,
    }, deps)

    const pv = (await playerW.getVtxos())[0]
    const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
    const cf = buildCofundFromPlay({
      play: res, playerInputs: [toInput(pv)],
      playerChangePkScript: ArkAddress.decode(addr).pkScript, betAmount: BET, serverUnroll,
    })
    const arkTxSigned = await playerId.sign(cf.arkTx, [0])
    const cofundRes = await server.handleV4Cofund(res.gameId, {
      arkTx: base64.encode(arkTxSigned.toPSBT()),
      checkpoints: cf.checkpoints.map((c: Transaction) => base64.encode(c.toPSBT())),
    }, deps)
    const signedCps = await Promise.all(cofundRes.playerCheckpoints.map(async (b64: string) => {
      const cp = Transaction.fromPSBT(base64.decode(b64))
      let s = cp
      try { s = await playerId.sign(cp, Array.from({ length: cp.inputsLength }, (_, i) => i)) }
      catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
      return base64.encode(s.toPSBT())
    }))
    const finRes = await server.handleV4CofundFinalize(res.gameId, { playerCheckpoints: signedCps }, deps)
    expect(finRes.potOutpoint.value).toBe(2 * BET)

    const cv = res.covenant
    const pot = new CoinflipJointPotScript({
      creatorPubkey: hex.decode(cv.creatorPubkey), playerPubkey: hex.decode(cv.playerPubkey),
      serverPubkey: hex.decode(cv.serverPubkey), creatorHash: hex.decode(cv.creatorHash),
      playerHash: hex.decode(cv.playerHash), finalExpiration: BigInt(cv.finalExpiration), cancelDelay: BigInt(cv.cancelDelay),
      exitDelay: BigInt(cv.exitDelay), oddsN: cv.oddsN, oddsTarget: cv.oddsTarget, oddsLo: cv.oddsLo,
      emulatorPubkey: hex.decode(cv.emulatorPubkey), playerPayoutPkScript: hex.decode(cv.playerPayoutPkScript),
      housePayoutPkScript: hex.decode(cv.housePayoutPkScript), playerStake: BigInt(cv.playerStake), houseStake: BigInt(cv.houseStake),
    })
    const playerPkScript = ArkAddress.decode(addr).pkScript
    const indexer = new RestIndexerProvider(ARK_SERVER_URL)
    const signAndPostEmu = async (built: { arkTx: Transaction; checkpoints: Transaction[] }, label: string): Promise<string> => {
      const s = await playerId.sign(built.arkTx, [0])
      const cps = await Promise.all(built.checkpoints.map(async (c) => {
        let x = c
        try { x = await playerId.sign(c, Array.from({ length: c.inputsLength }, (_, i) => i)) }
        catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
        return base64.encode(x.toPSBT())
      }))
      const body = JSON.stringify({ arkTx: base64.encode(s.toPSBT()), checkpointTxs: cps })
      for (let a = 0; a < 12; a++) {
        const r = await fetch(`${EMULATOR_URL}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) })
        if (r.ok) return Transaction.fromPSBT(base64.decode((await r.json() as { signedArkTx: string }).signedArkTx)).id
        const text = await r.text()
        if (!(r.status >= 500 && /not found|VTXO_NOT_FOUND|failed to process/i.test(text)) || a === 11) throw new Error(`${label} rejected: ${r.status} ${text}`)
        await sleep(700 + a * 700)
      }
      throw new Error(`${label}: retries exhausted`)
    }
    const vtxoAt = async (pkScript: Uint8Array, txid: string): Promise<boolean> => {
      const pk = hex.encode(pkScript)
      // 60s budget: a loaded CI runner can take well over 20s to settle + index the
      // StageTwo / payout VTXO after the emulator post — this is the timeout-fragile
      // assertion that flaked under load (passes in <20s locally).
      for (let i = 0; i < 60; i++) {
        const { vtxos } = await indexer.getVtxos({ scripts: [pk] })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (vtxos.some((x: any) => x.txid === txid && x.value === 2 * BET)) return true
        await sleep(1000)
      }
      return false
    }

    // Stage 1: the player publishes the secret on-chain but does NOT /reveal to the
    // server (the malicious-loser / house-was-down path — the house must EXTRACT the
    // secret from the chain to settle, which is the defence against takeAll theft).
    const reveal = buildPlayerRevealTx({ pot, cofund: finRes.potOutpoint, playerRevealBytes: playerReveal, serverUnroll })
    const stageTwoTxid = await signAndPostEmu(reveal, 'playerReveal')
    expect(await vtxoAt(pot.stageTwo.pkScript, stageTwoTxid)).toBe(true)
    console.log('[v4-stage2-poll] stage 1 (no /reveal): pot -> StageTwo', stageTwoTxid)

    // The server's stage-2 poll detects the reveal and settles to the ACTUAL winner,
    // extracting the player's secret from the chain. Pre-empts the player's takeAll.
    const settled = await server.reconcileV4StageTwo(deps)
    expect(settled.length).toBeGreaterThanOrEqual(1)

    const game = await deps.repos.games.get(res.gameId)
    expect(game.status).toBe('resolved')
    // Independently recompute the winner from both secrets; assert the poll paid them.
    const houseSecret = hex.decode(game.house_secret_hex)
    const outcome = determineWinnerV3({ digit: houseSecret[0], salt: houseSecret.slice(1) }, { digit: playerReveal[0], salt: playerReveal.slice(1) }, 2, 1, 0)
    expect(game.winner).toBe(outcome === 'player' ? 'player' : 'house')
    const winnerPk = outcome === 'player' ? playerPkScript : hex.decode(cv.housePayoutPkScript)
    let paid = false
    for (const t of settled) { if (await vtxoAt(winnerPk, t)) { paid = true; break } }
    expect(paid).toBe(true)
    console.log('[v4-stage2-poll] server settled contested game to', outcome)
  }, 300_000)
})
