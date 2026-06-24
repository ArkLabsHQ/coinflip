/**
 * v4 SPIKE PROBE — is a two-party atomic co-fund possible at all?
 *
 * v3 funds its two escrows with two SEPARATE single-party offchain txs because
 * (per per-party-escrow.spike) co-signing a checkpoint across the client/server
 * boundary was deemed impractical. v4's joint pot needs the opposite: ONE
 * offchain tx with BOTH the player's and the house's inputs → one joint-pot
 * VTXO. This probe builds exactly that and tries to submit+finalize it, with
 * each party signing only its own input + its own checkpoint (the realistic
 * API handshake). Pass ⇒ the joint pot is feasible. Fail ⇒ v4 falls back to
 * per-party funding (design §ammend). This decides the architecture.
 */
import { base64, hex } from '@scure/base'
import {
  Wallet, SingleKey, RestArkProvider, InMemoryWalletRepository, InMemoryContractRepository,
  decodeTapscript, buildOffchainTx, CSVMultisigTapscript, Transaction, ArkAddress,
  type ArkInfo, type ArkProvider, type ArkTxInput, type Identity,
} from '@arkade-os/sdk'
import { faucet, waitVtxos } from './helpers'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const BET = 1000
const FUND_BTC = 0.001
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function makeWallet(identity: SingleKey): Promise<Wallet> {
  return Wallet.create({
    identity, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
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
  throw new Error(`Timeout waiting for ${kind} >= ${min}`)
}
async function settleWithRetry(w: Wallet, tries = 3): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await w.settle(); return } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('No inputs found') || i === tries - 1) throw e
      await sleep(5000)
    }
  }
}
async function fundAndSettle(w: Wallet): Promise<void> {
  await faucet(await w.getBoardingAddress(), FUND_BTC)
  await waitFor(w, 'boarding', BET)
  await settleWithRetry(w)
  await waitFor(w, 'settled', BET)
}
function vtxoInput(v: { txid: string; vout: number; value: number; forfeitTapLeafScript: unknown; tapTree: Uint8Array }): ArkTxInput {
  return { txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript as ArkTxInput['tapLeafScript'], tapTree: v.tapTree }
}

// Net inherent real-stack co-fund transients (VTXO renew/expire mid-co-fund), as v4-server-play does. See #40.
jest.retryTimes(2, { logErrorsBeforeRetry: true })

describe('v4 spike: two-party atomic co-fund', () => {
  let arkAvailable = false
  let arkProvider: ArkProvider
  let arkInfo: ArkInfo
  let serverUnroll: CSVMultisigTapscript.Type
  beforeAll(async () => {
    try {
      arkProvider = new RestArkProvider(ARK_SERVER_URL)
      arkInfo = await arkProvider.getInfo()
      serverUnroll = decodeTapscript(hex.decode(arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
      arkAvailable = !!arkInfo?.signerPubkey
    } catch { arkAvailable = false }
  }, 20_000)

  it('builds + submits ONE offchain tx with player + house inputs (the joint-pot co-fund)', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    const playerId = SingleKey.fromRandomBytes()
    const houseId = SingleKey.fromRandomBytes()
    const playerW = await makeWallet(playerId)
    const houseW = await makeWallet(houseId)
    await fundAndSettle(playerW)
    await fundAndSettle(houseW)

    const pv = (await waitVtxos(playerW))[0]
    const hv = (await waitVtxos(houseW))[0]
    // Joint-pot output stand-in: send 2*BET to the player's address (the OUTPUT
    // covenant is irrelevant to THIS question — we only test whether a 2-input,
    // 2-signer offchain tx submits+finalizes at all). Change back to each owner.
    const potAddr = ArkAddress.decode(await playerW.getAddress()).pkScript
    const pChange = ArkAddress.decode(await playerW.getAddress()).pkScript
    const hChange = ArkAddress.decode(await houseW.getAddress()).pkScript
    const outputs = [
      { script: potAddr, amount: BigInt(2 * BET) },
      { script: pChange, amount: BigInt(pv.value - BET) },
      { script: hChange, amount: BigInt(hv.value - BET) },
    ]
    const { arkTx, checkpoints } = buildOffchainTx([vtxoInput(pv), vtxoInput(hv)], outputs, serverUnroll)

    // Two-party signing: player signs input 0, house signs input 1 (sequential —
    // each adds its sig to its own input; the other input's sig is preserved).
    let signed = await playerId.sign(arkTx, [0])
    signed = await houseId.sign(signed, [1])

    const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(signed.toPSBT()), checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    console.log('[v4-probe] co-fund submitTx ok, arkTxid =', arkTxid, 'checkpoints =', signedCheckpointTxs.length)

    // Each party signs its OWN checkpoint (checkpoint i belongs to input i).
    const finals: string[] = []
    for (let i = 0; i < signedCheckpointTxs.length; i++) {
      const tx = Transaction.fromPSBT(base64.decode(signedCheckpointTxs[i]))
      const idx = Array.from({ length: tx.inputsLength }, (_, k) => k)
      const owner = i === 0 ? playerId : houseId
      let s = tx
      try { s = await owner.sign(tx, idx) } catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
      finals.push(base64.encode(s.toPSBT()))
    }
    await arkProvider.finalizeTx(arkTxid, finals)
    console.log('[v4-probe] co-fund finalized — TWO-PARTY ATOMIC CO-FUND IS FEASIBLE')

    expect(typeof arkTxid).toBe('string')
    expect(arkTxid.length).toBeGreaterThan(0)
  }, 180_000)
})
