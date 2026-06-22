/**
 * v4 SPIKE PROBE — does a full joint-pot game SETTLE end-to-end?
 *
 * Co-fund a CoinflipJointPotScript pot from player+house inputs (proven by
 * v4-cofund-probe), then settle the whole pot to the winner via the win-covenant
 * leaf + emulator (single input, single output, payTo covenant; witness =
 * [encodeIndex(0)]). Pass ⇒ the v4 protocol works end-to-end. This is the gate
 * before the scale harness.
 */
import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import { CoinflipJointPotScript, determineWinnerV3, buildJointPotSettleTx, encodeSettleForEmulator } from 'arkade-coinflip'
import {
  Wallet, SingleKey, RestArkProvider, RestIndexerProvider, InMemoryWalletRepository,
  InMemoryContractRepository, decodeTapscript, buildOffchainTx, CSVMultisigTapscript,
  Transaction, ArkAddress, type ArkInfo, type ArkProvider, type ArkTxInput,
} from '@arkade-os/sdk'
import { packets } from '@arklabshq/contract-workflows-prototype'
import { faucet } from './helpers'

const ARK = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMU = process.env.EMULATOR_URL || 'http://localhost:7073'
const HRP = 'rark'
const BET = 1000
const FUND_BTC = 0.001
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
    const b = await w.getBalance()
    if ((kind === 'boarding' ? b.boarding.total : b.settled) >= min) return
    await sleep(2000)
  }
  throw new Error(`Timeout ${kind} >= ${min}`)
}
async function settleRetry(w: Wallet, tries = 3): Promise<void> {
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

describe('v4 spike: full joint-pot game settles end-to-end', () => {
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

  it('co-funds a joint pot and settles the full pot to the winner', async () => {
    if (!arkAvailable) { console.warn('ark/emu unavailable — skipped'); return }

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

    // Coin (n=2,target=1,lo=0): roll=(dC+dP)%2; player wins iff roll==0.
    // Choose dP=0, dC=0 → roll 0 → PLAYER wins (deterministic for the probe).
    const saltP = crypto.getRandomValues(new Uint8Array(16))
    const saltC = crypto.getRandomValues(new Uint8Array(16))
    const playerRevealBytes = packets.encodeReveal(0, saltP)
    const creatorRevealBytes = packets.encodeReveal(0, saltC)
    const playerHash = sha(playerRevealBytes)
    const creatorHash = sha(creatorRevealBytes)
    const winner = determineWinnerV3({ digit: 0, salt: saltC }, { digit: 0, salt: saltP }, 2, 1, 0)
    expect(winner).toBe('player')

    const pot = new CoinflipJointPotScript({
      creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey: serverPub,
      creatorHash, playerHash, finalExpiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
      cancelDelay: BigInt(Math.floor(Date.now() / 1000) + 1800),
      exitDelay: 86_528n, oddsN: 2, oddsTarget: 1, oddsLo: 0,
      emulatorPubkey: emuPubkey, playerPayoutPkScript: playerPayout, housePayoutPkScript: housePayout,
      playerStake: BigInt(BET), houseStake: BigInt(BET),
    })
    const potAddr = pot.address(HRP, serverPub).pkScript

    // ── Atomic co-fund: player + house inputs → joint-pot VTXO (output 0) ──
    const pv = (await playerW.getVtxos())[0]
    const hv = (await houseW.getVtxos())[0]
    const cofundOuts = [
      { script: potAddr, amount: BigInt(2 * BET) },
      { script: ArkAddress.decode(await playerW.getAddress()).pkScript, amount: BigInt(pv.value - BET) },
      { script: ArkAddress.decode(await houseW.getAddress()).pkScript, amount: BigInt(hv.value - BET) },
    ]
    const cofund = buildOffchainTx([input(pv), input(hv)], cofundOuts, serverUnroll)
    let cofundSigned = await playerId.sign(cofund.arkTx, [0])
    cofundSigned = await houseId.sign(cofundSigned, [1])
    const { arkTxid: cofundTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(cofundSigned.toPSBT()), cofund.checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const cofundFinals: string[] = []
    for (let i = 0; i < signedCheckpointTxs.length; i++) {
      const tx = Transaction.fromPSBT(base64.decode(signedCheckpointTxs[i]))
      const owner = i === 0 ? playerId : houseId
      let s = tx
      try { s = await owner.sign(tx, Array.from({ length: tx.inputsLength }, (_, k) => k)) }
      catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
      cofundFinals.push(base64.encode(s.toPSBT()))
    }
    await arkProvider.finalizeTx(cofundTxid, cofundFinals)
    console.log('[v4-game] joint pot co-funded:', cofundTxid, '(2000 sats)')

    // ── Settle: spend the pot via the winner's win leaf, full pot → winner ──
    // (uses the shared lib builder — same logic the server/client will call).
    const settle = buildJointPotSettleTx({
      pot,
      cofund: { txid: cofundTxid, vout: 0, value: 2 * BET },
      winner,
      winnerPayoutPkScript: winner === 'player' ? playerPayout : housePayout,
      potAmount: BigInt(2 * BET),
      playerRevealBytes,
      creatorRevealBytes,
      serverUnroll,
    })
    const body = JSON.stringify(encodeSettleForEmulator(settle))
    let settleTxid = ''
    for (let attempt = 0; attempt < 10; attempt++) {
      const resp = await fetch(`${EMU}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(25_000) })
      if (resp.ok) { settleTxid = Transaction.fromPSBT(base64.decode((await resp.json() as { signedArkTx: string }).signedArkTx)).id; break }
      const text = await resp.text()
      const transient = resp.status >= 500 && /not found|VTXO_NOT_FOUND|failed to process/i.test(text)
      if (!transient || attempt === 9) throw new Error(`emulator rejected settle: ${resp.status} ${text}`)
      await sleep(500 + attempt * 500)
    }
    console.log('[v4-game] SETTLED — pot swept to player:', settleTxid)

    // Verify the player received the full pot.
    const indexer = new RestIndexerProvider(ARK)
    const playerPk = hex.encode(playerPayout)
    let got = false
    for (let i = 0; i < 20 && !got; i++) {
      const { vtxos } = await indexer.getVtxos({ scripts: [playerPk] })
      if (vtxos.some((v) => v.txid === settleTxid && v.value === 2 * BET)) got = true
      else await sleep(1000)
    }
    expect(got).toBe(true)
    console.log('[v4-game] VERIFIED — player holds the 2000-sat pot VTXO. v4 SETTLES END-TO-END.')
  }, 240_000)
})
