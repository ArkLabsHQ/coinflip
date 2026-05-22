/**
 * Per-party escrow spike.
 *
 * Proves the architecture that makes trustless settlement wireable in a real
 * client/server (the co-funded setup needed both parties to co-sign post-submit
 * checkpoints — impossible across an HTTP boundary). Here:
 *
 *   - escrow contract = CoinflipFinalScript (creatorWin / playerWin / abort)
 *   - each party sends their stake to the SAME escrow address with an ordinary
 *     SINGLE-PARTY offchain tx (the sender signs its own input + checkpoint)
 *   - the winner sweeps BOTH escrow VTXOs through their leaf in one tx — also
 *     single-party (winner + arkd server), with both secrets as witness.
 *
 * No step needs the counterparty to sign a checkpoint, so this maps cleanly
 * onto: client sends player stake, server sends house stake, winner sweeps.
 */

import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import {
  CoinflipFinalScript,
  generateSecret,
  type VtxoInput,
} from 'arkade-coinflip'
import {
  Wallet,
  SingleKey,
  RestArkProvider,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  ConditionWitness,
  setArkPsbtField,
  decodeTapscript,
  buildOffchainTx,
  CSVMultisigTapscript,
  Transaction,
  VtxoScript,
  ArkAddress,
  type ArkInfo,
  type ArkProvider,
  type ArkTxInput,
  type Identity,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'
const NETWORK_HRP = 'rark'
const BET = 1000
const FUND_BTC = 0.001

const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
const toXOnly = (p: Uint8Array) => (p.length === 33 ? p.slice(1) : p)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function faucet(address: string, amountBtc: number): Promise<void> {
  const resp = await fetch(`${ESPLORA_URL}/faucet`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, amount: amountBtc }),
  })
  if (!resp.ok) throw new Error(`Faucet failed: ${resp.status} ${await resp.text()}`)
}

async function makeWallet(identity: SingleKey): Promise<Wallet> {
  return Wallet.create({
    identity, arkServerUrl: ARK_SERVER_URL, esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: false,
  })
}

async function waitFor(w: Wallet, kind: 'boarding' | 'settled', min: number, timeoutMs = 90_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const b = await w.getBalance()
    if ((kind === 'boarding' ? b.boarding.total : b.settled) >= min) return
    await sleep(2000)
  }
  throw new Error(`Timeout waiting for ${kind} >= ${min}`)
}

function vtxoToInput(v: ExtendedVirtualCoin): VtxoInput {
  const fullScript = VtxoScript.decode(v.tapTree)
  const tapscripts = fullScript.scripts.map((s) => hex.encode(s))
  const forfeitScript = v.forfeitTapLeafScript[1].slice(0, -1)
  return { vtxo: { outpoint: { txid: v.txid, vout: v.vout }, amount: v.value.toString(), tapscripts }, leaf: hex.encode(forfeitScript) }
}

async function trySign(tx: Transaction, id: Identity, indices: number[]): Promise<Transaction> {
  try { return await id.sign(tx, indices) } catch (e) {
    if (String(e).includes('No taproot scripts signed')) return tx
    throw e
  }
}

describe('spike: per-party escrow + winner sweep', () => {
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
  }, 15_000)

  // Single-party offchain spend: sender signs its input(s) + the post-submit
  // checkpoints (which only it owns), arkd co-signs. Optionally supplies a
  // condition witness (revealed secrets) on every input.
  async function spend(
    arkTx: Transaction, checkpoints: Transaction[], signer: Identity, signInputs: number[],
    witness?: Uint8Array[],
  ): Promise<string> {
    if (witness) for (const i of signInputs) setArkPsbtField(arkTx, i, ConditionWitness, witness)
    const signed = await signer.sign(arkTx, signInputs)
    const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(signed.toPSBT()), checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const finals: string[] = []
    for (const c of signedCheckpointTxs) {
      let tx = Transaction.fromPSBT(base64.decode(c))
      const idx: number[] = []
      for (let i = 0; i < tx.inputsLength; i++) idx.push(i)
      if (witness) for (const i of idx) setArkPsbtField(tx, i, ConditionWitness, witness)
      tx = await trySign(tx, signer, idx)
      finals.push(base64.encode(tx.toPSBT()))
    }
    await arkProvider.finalizeTx(arkTxid, finals)
    return arkTxid
  }

  // One party escrows `amount` into the escrow address from a single wallet
  // VTXO; returns the escrow VTXO outpoint (escrowTxid, 0).
  async function escrow(
    wallet: Wallet, id: Identity, escrowPkScript: Uint8Array, changeAddr: string, amount: number,
  ): Promise<{ txid: string; vout: number; value: number }> {
    const vtxo = (await wallet.getVtxos())[0]
    const input: ArkTxInput = {
      txid: vtxo.txid, vout: vtxo.vout, value: vtxo.value,
      tapLeafScript: vtxo.forfeitTapLeafScript, tapTree: vtxo.tapTree,
    }
    const change = vtxo.value - amount
    const outputs = [{ script: escrowPkScript, amount: BigInt(amount) }]
    if (change > 0) outputs.push({ script: ArkAddress.decode(changeAddr).pkScript, amount: BigInt(change) })
    const { arkTx, checkpoints } = buildOffchainTx([input], outputs, serverUnroll)
    const txid = await spend(arkTx, checkpoints, id, [0])
    return { txid, vout: 0, value: amount }
  }

  it('escrows both stakes via single-party sends and the winner sweeps the pot', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    const houseId = SingleKey.fromRandomBytes()
    const playerId = SingleKey.fromRandomBytes()
    const houseW = await makeWallet(houseId)
    const playerW = await makeWallet(playerId)
    await faucet(await houseW.getBoardingAddress(), FUND_BTC)
    await faucet(await playerW.getBoardingAddress(), FUND_BTC)
    await waitFor(houseW, 'boarding', BET); await waitFor(playerW, 'boarding', BET)
    await houseW.settle(); await playerW.settle()
    await waitFor(houseW, 'settled', BET); await waitFor(playerW, 'settled', BET)

    const housePub = await houseId.xOnlyPublicKey()
    const playerPub = await playerId.xOnlyPublicKey()
    const serverPubkey = toXOnly(hex.decode(arkInfo.signerPubkey))
    const creatorSecret = generateSecret('heads') // 15 → house (creator) wins vs tails
    const playerSecret = generateSecret('tails')
    const now = Math.floor(Date.now() / 1000)

    // Escrow contract: the same CoinflipFinalScript both parties fund.
    const escrowScript = new CoinflipFinalScript({
      creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey,
      creatorHash: sha(creatorSecret), playerHash: sha(playerSecret), finalExpiration: BigInt(now + 1200),
    })
    const escrowAddr = escrowScript.address(NETWORK_HRP, serverPubkey)
    console.log('[escrow] address:', escrowAddr.encode())

    // Each party escrows its stake — single-party sends.
    const houseEscrow = await escrow(houseW, houseId, escrowAddr.pkScript, await houseW.getAddress(), BET)
    const playerEscrow = await escrow(playerW, playerId, escrowAddr.pkScript, await playerW.getAddress(), BET)
    console.log('[escrow] house:', houseEscrow.txid, 'player:', playerEscrow.txid)

    // House won (different secret sizes). Sweep BOTH escrow VTXOs via creatorWin.
    const leaf = escrowScript.creatorWin()
    const tapTree = escrowScript.encode()
    const sweepInputs: ArkTxInput[] = [houseEscrow, playerEscrow].map((e) => ({
      txid: e.txid, vout: e.vout, value: e.value, tapLeafScript: leaf, tapTree,
    }))
    const pot = houseEscrow.value + playerEscrow.value
    const houseAddr = ArkAddress.decode(await houseW.getAddress())
    const { arkTx: sweep, checkpoints: sweepCps } = buildOffchainTx(
      sweepInputs, [{ script: houseAddr.pkScript, amount: BigInt(pot) }], serverUnroll,
    )

    const vtxoTotal = async () => (await houseW.getVtxos()).reduce((a, v) => a + v.value, 0)
    const before = await vtxoTotal()
    const sweepTxid = await spend(sweep, sweepCps, houseId, [0, 1], [creatorSecret, playerSecret])
    console.log('[escrow] sweep:', sweepTxid)

    await sleep(6000)
    const after = await vtxoTotal()
    console.log('[escrow] house total before sweep:', before, 'after:', after)
    expect(after - before).toBeGreaterThanOrEqual(pot - 100)
  }, 300_000)
})
