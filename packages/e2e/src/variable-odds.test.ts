/**
 * Variable-odds on-chain condition e2e. The win condition is hand-assembled
 * Bitcoin Script (roll = (digitC + digitP) mod n, player wins iff roll < target;
 * mod via a conditional OP_SUB since OP_MOD is disabled). It can only be
 * verified by having arkd actually execute it, so we escrow real stakes into a
 * variable-odds CoinflipEscrowScript and sweep via the winner's leaf:
 *
 *   - the winner (per determineVariableWinner) CAN sweep — covering player/house
 *     wins, the mod wraparound (sum ≥ n), and the roll == target boundary;
 *   - the loser CANNOT (the condition pushes the other result → VERIFY fails).
 *
 * A green run is proof the off-chain mirror and the on-chain script agree and
 * that the script is sound (no one sweeps a leaf they didn't win).
 */

import { base64, hex } from '@scure/base'
import { createHash, randomBytes } from 'crypto'
import {
  CoinflipEscrowScript, determineVariableWinner, VARIABLE_ODDS_BASE_LEN,
} from 'arkade-coinflip'
import {
  Wallet, SingleKey, RestArkProvider, InMemoryWalletRepository, InMemoryContractRepository,
  ConditionWitness, setArkPsbtField, decodeTapscript, buildOffchainTx, CSVMultisigTapscript,
  Transaction, ArkAddress,
  type ArkInfo, type ArkProvider, type ArkTxInput, type Identity, type ExtendedVirtualCoin,
} from '@arkade-os/sdk'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'
const HRP = 'tark' // cosmetic — we escrow into pkScript, which is HRP-independent
const BET = 1000
const FUND_BTC = 0.01 // generous so several cases can run off one funding

const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
const toXOnly = (p: Uint8Array) => (p.length === 33 ? p.slice(1) : p)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const secretOfDigit = (digit: number) => new Uint8Array(randomBytes(VARIABLE_ODDS_BASE_LEN + digit))

async function faucet(address: string, amountBtc: number): Promise<void> {
  const r = await fetch(`${ESPLORA_URL}/faucet`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, amount: amountBtc }),
  })
  if (!r.ok) throw new Error(`Faucet failed: ${r.status} ${await r.text()}`)
}
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

let arkAvailable = false

describe('variable-odds on-chain condition', () => {
  let arkProvider: ArkProvider
  let arkInfo: ArkInfo
  let serverUnroll: CSVMultisigTapscript.Type
  let serverPubkey: Uint8Array
  let houseId: SingleKey, playerId: SingleKey
  let houseW: Wallet, playerW: Wallet

  beforeAll(async () => {
    try {
      arkProvider = new RestArkProvider(ARK_SERVER_URL)
      arkInfo = await arkProvider.getInfo()
      arkAvailable = !!arkInfo?.signerPubkey
    } catch { arkAvailable = false }
    if (!arkAvailable) return
    serverUnroll = decodeTapscript(hex.decode(arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type
    serverPubkey = toXOnly(hex.decode(arkInfo.signerPubkey))
    houseId = SingleKey.fromRandomBytes(); playerId = SingleKey.fromRandomBytes()
    houseW = await makeWallet(houseId); playerW = await makeWallet(playerId)
    await faucet(await houseW.getBoardingAddress(), FUND_BTC)
    await faucet(await playerW.getBoardingAddress(), FUND_BTC)
    await waitFor(houseW, 'boarding', BET); await waitFor(playerW, 'boarding', BET)
    await houseW.settle(); await playerW.settle()
    await waitFor(houseW, 'settled', BET * 3); await waitFor(playerW, 'settled', BET * 3)
  }, 180_000)

  async function spend(arkTx: Transaction, checkpoints: Transaction[], signer: Identity, signInputs: number[], witness?: Uint8Array[]): Promise<string> {
    if (witness) for (const i of signInputs) setArkPsbtField(arkTx, i, ConditionWitness, witness)
    const signed = await signer.sign(arkTx, signInputs)
    const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(signed.toPSBT()), checkpoints.map((c) => base64.encode(c.toPSBT())),
    )
    const finals: string[] = []
    for (const c of signedCheckpointTxs) {
      const tx = Transaction.fromPSBT(base64.decode(c))
      const idx = Array.from({ length: tx.inputsLength }, (_, i) => i)
      if (witness) for (const i of idx) setArkPsbtField(tx, i, ConditionWitness, witness)
      finals.push(base64.encode((await signer.sign(tx, idx)).toPSBT()))
    }
    await arkProvider.finalizeTx(arkTxid, finals)
    return arkTxid
  }

  async function escrow(w: Wallet, id: Identity, pkScript: Uint8Array, amount: number): Promise<{ txid: string; vout: number; value: number }> {
    const v = (await w.getVtxos()).find((x: ExtendedVirtualCoin) => x.value >= amount)
    if (!v) throw new Error('no VTXO >= amount')
    const change = v.value - amount
    const outs: { script: Uint8Array; amount: bigint }[] = [{ script: pkScript, amount: BigInt(amount) }]
    if (change > 0) outs.push({ script: ArkAddress.decode(await w.getAddress()).pkScript, amount: BigInt(change) })
    const { arkTx, checkpoints } = buildOffchainTx(
      [{ txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript, tapTree: v.tapTree }], outs, serverUnroll,
    )
    return { txid: await spend(arkTx, checkpoints, id, [0]), vout: 0, value: amount }
  }

  const total = async (w: Wallet) => (await w.getVtxos()).reduce((a, v) => a + v.value, 0)

  it('the winner (and only the winner) sweeps across odds, wraparound, and the boundary', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const housePub = await houseId.xOnlyPublicKey()
    const playerPub = await playerId.xOnlyPublicKey()
    const past = BigInt(Math.floor(Date.now() / 1000) - 3600)

    // n=6, target=3 → player wins 1/2. Cases cover: player no-wrap, house
    // boundary (roll==target), house with-wrap+boundary, player with-wrap.
    const cases: Array<[number, number, number, number]> = [
      [6, 3, 0, 0], // sum 0 → roll 0 < 3 → player
      [6, 3, 1, 2], // sum 3 → roll 3 == target → house
      [6, 3, 4, 5], // sum 9 → 9-6=3 == target → house (wraps)
      [6, 3, 5, 2], // sum 7 → 7-6=1 < 3 → player (wraps)
    ]

    for (const [n, target, dC, dP] of cases) {
      const cSecret = secretOfDigit(dC)
      const pSecret = secretOfDigit(dP)
      const script = new CoinflipEscrowScript({
        creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey,
        creatorHash: sha(cSecret), playerHash: sha(pSecret),
        finalExpiration: past, refundPubkey: housePub, oddsN: n, oddsTarget: target,
      })
      const pk = script.address(HRP, serverPubkey).pkScript
      const hEsc = await escrow(houseW, houseId, pk, BET)
      const pEsc = await escrow(playerW, playerId, pk, BET)

      const winner = determineVariableWinner(cSecret, pSecret, n, target)
      const leaf = winner === 'creator' ? script.creatorWin() : script.playerWin()
      const winId = winner === 'creator' ? houseId : playerId
      const winW = winner === 'creator' ? houseW : playerW
      const winAddr = ArkAddress.decode(await winW.getAddress())
      const tapTree = script.encode()
      const pot = hEsc.value + pEsc.value
      const inputs: ArkTxInput[] = [hEsc, pEsc].map((e) => ({ txid: e.txid, vout: e.vout, value: e.value, tapLeafScript: leaf, tapTree }))
      const { arkTx, checkpoints } = buildOffchainTx(inputs, [{ script: winAddr.pkScript, amount: BigInt(pot) }], serverUnroll)

      const before = await total(winW)
      await spend(arkTx, checkpoints, winId, [0, 1], [cSecret, pSecret])
      await sleep(6000)
      const after = await total(winW)
      console.log(`[variable-odds] n=${n} target=${target} digits(${dC},${dP}) → ${winner} wins; ${before}→${after}`)
      expect(after - before).toBeGreaterThanOrEqual(pot - 100)
    }
  }, 300_000)

  it('the loser cannot sweep via its own win leaf (condition rejects)', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const housePub = await houseId.xOnlyPublicKey()
    const playerPub = await playerId.xOnlyPublicKey()
    const past = BigInt(Math.floor(Date.now() / 1000) - 3600)

    // digits (0,0) → roll 0 < 3 → PLAYER wins. The house must NOT be able to
    // sweep via creatorWin.
    const cSecret = secretOfDigit(0), pSecret = secretOfDigit(0)
    const script = new CoinflipEscrowScript({
      creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey,
      creatorHash: sha(cSecret), playerHash: sha(pSecret),
      finalExpiration: past, refundPubkey: housePub, oddsN: 6, oddsTarget: 3,
    })
    expect(determineVariableWinner(cSecret, pSecret, 6, 3)).toBe('player')
    const pk = script.address(HRP, serverPubkey).pkScript
    const hEsc = await escrow(houseW, houseId, pk, BET)
    const pEsc = await escrow(playerW, playerId, pk, BET)

    const leaf = script.creatorWin() // house tries to steal via the wrong leaf
    const tapTree = script.encode()
    const houseAddr = ArkAddress.decode(await houseW.getAddress())
    const inputs: ArkTxInput[] = [hEsc, pEsc].map((e) => ({ txid: e.txid, vout: e.vout, value: e.value, tapLeafScript: leaf, tapTree }))
    const { arkTx, checkpoints } = buildOffchainTx(inputs, [{ script: houseAddr.pkScript, amount: BigInt(hEsc.value + pEsc.value) }], serverUnroll)

    await expect(spend(arkTx, checkpoints, houseId, [0, 1], [cSecret, pSecret])).rejects.toThrow()
    console.log('[variable-odds] loser-leaf sweep correctly rejected')
  }, 180_000)
})
