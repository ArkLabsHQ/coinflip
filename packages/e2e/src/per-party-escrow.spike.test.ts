/**
 * Per-party escrow spike — player self-refund path.
 *
 * Proves the per-party architecture now shipped as the live CoinflipEscrowScript:
 * each party sends its stake to the SAME escrow address with an ordinary
 * SINGLE-PARTY offchain tx (the sender signs its own input + checkpoint), so no
 * step needs the counterparty to co-sign a checkpoint — impossible across an
 * HTTP boundary. That maps cleanly onto: client sends player stake, server sends
 * house stake.
 *
 * This spike exercises the player's CLTV self-refund leaf after a house stall:
 * the player reclaims its own escrow with only player+server sigs (no emulator),
 * via buildRefundTransaction against a real CoinflipEscrowScript.
 */

import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import {
  CoinflipEscrowScript,
  buildRefundTransaction,
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
import { faucet } from './helpers'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const NETWORK_HRP = 'rark'
const BET = 1000
const FUND_BTC = 0.001

const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
const toXOnly = (p: Uint8Array) => (p.length === 33 ? p.slice(1) : p)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))


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

// settle() can throw a transient "No inputs found" when arkd hasn't yet indexed
// the just-fauceted boarding UTXO — waitFor's balance probe sees it before the
// settle's input gathering does. Retry ONLY that signal (rethrow anything else
// immediately so real failures aren't masked). Mirrors the sibling e2e tests.
async function settleWithRetry(w: Wallet, tries = 3): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await w.settle(); return } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('No inputs found') || i === tries - 1) throw e
      await sleep(5000)
    }
  }
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

  it('player refunds its own escrow after a stall (house griefs)', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }

    const houseId = SingleKey.fromRandomBytes() // house never escrows — it stalls
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await makeWallet(playerId)
    await faucet(await playerW.getBoardingAddress(), FUND_BTC)
    await waitFor(playerW, 'boarding', BET)
    await settleWithRetry(playerW)
    await waitFor(playerW, 'settled', BET)

    const housePub = await houseId.xOnlyPublicKey()
    const playerPub = await playerId.xOnlyPublicKey()
    const serverPubkey = toXOnly(hex.decode(arkInfo.signerPubkey))
    // finalExpiration in the PAST so the refund's CLTV is already satisfiable.
    const past = Math.floor(Date.now() / 1000) - 3600

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { schnorr } = require('@noble/curves/secp256k1.js')
    const playerPkScript = ArkAddress.decode(await playerW.getAddress()).pkScript
    const playerEscrowScript = new CoinflipEscrowScript({
      creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey,
      creatorHash: sha(generateSecret('heads')), playerHash: sha(generateSecret('tails')),
      finalExpiration: BigInt(past),
      exitDelay: 86_528n, // BIP68 seconds, multiple of 512
      refundPubkey: playerPub, // player-only refund — the leaf this test exercises
      // arkadeForfeit is required by the type. The covenant leaves are present
      // but unused here: only the CLTVMultisig[player, server] refund leaf is
      // spent, which needs no emulator — so this test still runs on arkd alone.
      arkadeForfeit: {
        emulatorPubkey: schnorr.getPublicKey(new Uint8Array(32).fill(0x40)),
        playerPayoutPkScript: playerPkScript,
        housePayoutPkScript: playerPkScript,
        playerStake: BigInt(BET),
        houseStake: BigInt(BET),
      },
    })
    const escrowAddr = playerEscrowScript.address(NETWORK_HRP, serverPubkey)

    const playerEscrow = await escrow(playerW, playerId, escrowAddr.pkScript, await playerW.getAddress(), BET)
    console.log('[refund] player escrowed:', playerEscrow.txid)

    const vtxoTotal = async () => (await playerW.getVtxos()).reduce((a, v) => a + v.value, 0)
    const before = await vtxoTotal()
    const refund = buildRefundTransaction(arkInfo, NETWORK_HRP, {
      escrowScript: playerEscrowScript, txid: playerEscrow.txid, vout: playerEscrow.vout,
      value: playerEscrow.value, refundAddress: await playerW.getAddress(),
    })
    const refundTxid = await spend(refund.arkTx, refund.checkpoints, playerId, [0])
    console.log('[refund] refunded:', refundTxid)

    await sleep(6000)
    const after = await vtxoTotal()
    console.log('[refund] player total before refund:', before, 'after:', after)
    // The escrowed stake comes back to the player.
    expect(after - before).toBeGreaterThanOrEqual(BET - 100)
  }, 300_000)
})
