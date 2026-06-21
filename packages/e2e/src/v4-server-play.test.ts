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
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { base64, hex } from '@scure/base'
import {
  SingleKey, Wallet, InMemoryWalletRepository, InMemoryContractRepository,
  decodeTapscript, CSVMultisigTapscript, RestIndexerProvider, Transaction, ArkAddress, type ArkTxInput,
} from '@arkade-os/sdk'
import { CoinflipJointPotScript, buildJointPotCofundTx, jointPotCofundOutputs } from 'arkade-coinflip'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { packets } = require('@arklabshq/contract-workflows-prototype')
import { faucet, settleWithRetry } from './helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toInput = (v: any): ArkTxInput => ({ txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript, tapTree: v.tapTree })

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

describe('v4 server: handleV4Play', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deps: any
  let dataDir: string

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
    await server.ensureHouseVtxoPool(deps, { targetCount: 6, pieceSize: BET * 5 })
  }, 180_000)

  afterAll(() => {
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
    expect(res.houseVtxo.value).toBeGreaterThanOrEqual(BET)
    expect(typeof res.houseVtxo.txid).toBe('string')
    expect(res.potAddress.startsWith(res.networkHrp)).toBe(true)

    // Headline: re-derive the covenant client-side → byte-identical pot address.
    const cv = res.covenant
    const rebuilt = new CoinflipJointPotScript({
      creatorPubkey: hex.decode(cv.creatorPubkey),
      playerPubkey: hex.decode(cv.playerPubkey),
      serverPubkey: hex.decode(cv.serverPubkey),
      creatorHash: hex.decode(cv.creatorHash),
      playerHash: hex.decode(cv.playerHash),
      finalExpiration: BigInt(cv.finalExpiration),
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

  it('co-funds the joint pot via the 2-round handshake → pot VTXO lands', async () => {
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

    // Client builds the co-fund: player input (funded) + the reserved house input.
    const pv = (await playerW.getVtxos())[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hv = (await deps.wallet.getVtxos()).find((v: any) => v.txid === res.houseVtxo.txid && v.vout === res.houseVtxo.vout)
    expect(hv).toBeDefined()
    const serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
    const cofundOuts = jointPotCofundOutputs({
      potPkScript: ArkAddress.decode(res.potAddress).pkScript, potAmount: BigInt(res.pot),
      playerChangePkScript: ArkAddress.decode(await playerW.getAddress()).pkScript, playerChange: BigInt(pv.value - BET),
      houseChangePkScript: ArkAddress.decode(await deps.wallet.getAddress()).pkScript, houseChange: BigInt(hv.value - res.houseStake),
    })
    const cf = buildJointPotCofundTx(toInput(pv), toInput(hv), cofundOuts, serverUnroll)
    const arkTxPlayerSigned = await playerId.sign(cf.arkTx, [0])

    // Round 1: /cofund — server signs house input + checkpoint, returns the player checkpoint.
    const cofundRes = await server.handleV4Cofund(res.gameId, {
      arkTx: base64.encode(arkTxPlayerSigned.toPSBT()),
      checkpoints: cf.checkpoints.map((c: Transaction) => base64.encode(c.toPSBT())),
    }, deps)
    expect(typeof cofundRes.arkTxid).toBe('string')

    // Client signs its checkpoint (vin 0).
    const playerCp = Transaction.fromPSBT(base64.decode(cofundRes.playerCheckpoint))
    let playerCpSigned = playerCp
    try { playerCpSigned = await playerId.sign(playerCp, Array.from({ length: playerCp.inputsLength }, (_, i) => i)) }
    catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }

    // Round 2: /cofund-finalize — server finalizes → pot VTXO created.
    const finRes = await server.handleV4CofundFinalize(res.gameId, {
      playerCheckpoint: base64.encode(playerCpSigned.toPSBT()),
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
  }, 240_000)
})
