/**
 * Broadcast spike for the trustless-coin-settlement plan.
 *
 * Nothing in the repo has ever actually submitted the setup/final/claim txs to
 * arkd (game-flow builds + signs but stops; auto-claim is untested). This spike
 * proves the full chain end-to-end with funded wallets:
 *
 *   fund + settle → build setup/final (lib) → submit setup (escrow)
 *   → submit final (reveal creatorSecret) → submit creatorWin claim
 *   → assert the winner's balance rose.
 *
 * If it passes, Task 6 (server orchestration) is a refactor of this. If it
 * fails, the failing step is the concrete blocker (e.g. final tx needs arkd's
 * redeem-tx endpoint rather than buildOffchainTx).
 */

import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import {
  buildGameTransactions,
  buildClaimTransaction,
  getFinalOutpoint,
  generateSecret,
  getSetupAddress,
  type Game,
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
  Transaction,
  VtxoScript,
  type ArkInfo,
  type ArkProvider,
  type Identity,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'
const NETWORK_HRP = 'rark'
const BET = 1000
const FUND_BTC = 0.001 // 100k sats

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
    identity,
    arkServerUrl: ARK_SERVER_URL,
    esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: false,
  })
}

async function waitFor(wallet: Wallet, kind: 'boarding' | 'settled', min: number, timeoutMs = 90_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const b = await wallet.getBalance()
    const cur = kind === 'boarding' ? b.boarding.total : b.settled
    if (cur >= min) return
    await sleep(2000)
  }
  throw new Error(`Timeout waiting for ${kind} >= ${min}`)
}

// Mirror the server's vtxoToInput (game-engine.ts): decode the FULL tap tree
// so the reconstructed pkScript matches the indexed VTXO, and strip the
// trailing 0xc0 leaf-version byte (VtxoScript re-appends it) to avoid
// "Unknown opcode=c0".
function vtxoToInput(v: ExtendedVirtualCoin): VtxoInput {
  const fullScript = VtxoScript.decode(v.tapTree)
  const tapscripts = fullScript.scripts.map((s) => hex.encode(s))
  const forfeitScript = v.forfeitTapLeafScript[1].slice(0, -1)
  return { vtxo: { outpoint: { txid: v.txid, vout: v.vout }, amount: v.value.toString(), tapscripts }, leaf: hex.encode(forfeitScript) }
}

interface Signer { identity: Identity; inputs: number[] }
interface SubmitArgs {
  arkProvider: ArkProvider
  arkTx: Transaction
  checkpoints: Transaction[]
  signers: Signer[]
  /** Identities allowed to sign the post-submit checkpoints. Defaults to the
   * ark-tx signers. Set to e.g. [houseId] to test whether server-only
   * checkpoint signing is sufficient (decides if /commit can be server-side). */
  checkpointSigners?: Identity[]
  conditionWitness?: { index: number; data: Uint8Array[] }
}

// Sign, tolerating inputs this key doesn't control (SDK throws "No taproot
// scripts signed" when a key matches none of the requested inputs).
async function trySign(tx: Transaction, id: Identity, indices: number[]): Promise<Transaction> {
  try {
    return await id.sign(tx, indices)
  } catch (e) {
    if (String(e).includes('No taproot scripts signed')) return tx
    throw e
  }
}

async function submit(args: SubmitArgs): Promise<string> {
  const { arkProvider, arkTx, checkpoints, signers, conditionWitness } = args
  const checkpointSigners = args.checkpointSigners ?? signers.map((s) => s.identity)
  if (conditionWitness) setArkPsbtField(arkTx, conditionWitness.index, ConditionWitness, conditionWitness.data)
  let signed = arkTx
  for (const s of signers) signed = await s.identity.sign(signed, s.inputs)

  const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
    base64.encode(signed.toPSBT()),
    checkpoints.map((c) => base64.encode(c.toPSBT())),
  )

  const finalCheckpoints: string[] = []
  for (const c of signedCheckpointTxs) {
    let tx = Transaction.fromPSBT(base64.decode(c))
    if (conditionWitness) setArkPsbtField(tx, conditionWitness.index, ConditionWitness, conditionWitness.data)
    const idx: number[] = []
    for (let i = 0; i < tx.inputsLength; i++) idx.push(i)
    for (const id of checkpointSigners) tx = await trySign(tx, id, idx)
    finalCheckpoints.push(base64.encode(tx.toPSBT()))
  }
  await arkProvider.finalizeTx(arkTxid, finalCheckpoints)
  return arkTxid
}

describe('spike: trustless broadcast (setup → final → claim)', () => {
  let arkAvailable = false
  let arkProvider: ArkProvider
  let arkInfo: ArkInfo

  beforeAll(async () => {
    try {
      arkProvider = new RestArkProvider(ARK_SERVER_URL)
      arkInfo = await arkProvider.getInfo()
      arkAvailable = !!arkInfo?.signerPubkey
    } catch {
      arkAvailable = false
    }
  }, 15_000)

  // Offchain-tx outputs are preconfirmed (not "settled"), so measure total
  // spendable VTXO value rather than balance.settled.
  const vtxoTotal = async (w: Wallet) => (await w.getVtxos()).reduce((a, v) => a + v.value, 0)

  /**
   * Play one full trustless game; return the winner's spendable VTXO total
   * before/after the claim. `playerWins` controls secret sizes: equal → player
   * wins (determineWinner), different → house (creator) wins.
   */
  async function runGame(playerWins: boolean): Promise<{ before: number; after: number }> {
    const houseId = SingleKey.fromRandomBytes()
    const playerId = SingleKey.fromRandomBytes()
    const houseW = await makeWallet(houseId)
    const playerW = await makeWallet(playerId)

    await faucet(await houseW.getBoardingAddress(), FUND_BTC)
    await faucet(await playerW.getBoardingAddress(), FUND_BTC)
    await waitFor(houseW, 'boarding', BET)
    await waitFor(playerW, 'boarding', BET)
    await houseW.settle()
    await playerW.settle()
    await waitFor(houseW, 'settled', BET)
    await waitFor(playerW, 'settled', BET)

    const housePub = await houseId.xOnlyPublicKey()
    const playerPub = await playerId.xOnlyPublicKey()
    const serverPubkey = toXOnly(hex.decode(arkInfo.signerPubkey))
    const creatorSecret = generateSecret('heads') // 15 bytes
    const playerSecret = generateSecret(playerWins ? 'heads' : 'tails') // equal size → player wins

    const houseVtxos = await houseW.getVtxos()
    const playerVtxos = await playerW.getVtxos()
    const now = Math.floor(Date.now() / 1000)

    const game: Game = {
      gameId: `spike-${Date.now()}`,
      betAmount: BigInt(BET),
      serverPubkey,
      setupExpiration: now + 600,
      finalExpiration: now + 1200,
      creator: { pubkey: housePub, hash: sha(creatorSecret), vtxos: [vtxoToInput(houseVtxos[0])], changeAddress: await houseW.getAddress() },
      player: { pubkey: playerPub, hash: sha(playerSecret), vtxos: [vtxoToInput(playerVtxos[0])], changeAddress: await playerW.getAddress() },
    }

    const built = buildGameTransactions(game, arkInfo, NETWORK_HRP)
    console.log('[spike] setup id:', built.setup.arkTx.id, 'final id:', built.final.arkTx.id, 'escrow:', getSetupAddress(game, NETWORK_HRP).encode())

    // 1) Escrow both stakes.
    await submit({
      arkProvider, arkTx: built.setup.arkTx, checkpoints: built.setup.checkpoints,
      signers: [{ identity: houseId, inputs: [0] }, { identity: playerId, inputs: [1] }],
    })
    // 2) Reveal the house secret via the final tx.
    await submit({
      arkProvider, arkTx: built.final.arkTx, checkpoints: built.final.checkpoints,
      signers: [{ identity: houseId, inputs: [0] }, { identity: playerId, inputs: [0] }],
      conditionWitness: { index: 0, data: [creatorSecret] },
    })
    // 3) Winner claims the pot via their leaf (creatorWin / playerWin).
    const winner: 'house' | 'player' = playerWins ? 'player' : 'house'
    const winnerW = playerWins ? playerW : houseW
    const winnerId = playerWins ? playerId : houseId
    const claim = buildClaimTransaction(game, arkInfo, NETWORK_HRP, {
      winner,
      finalOutpoint: getFinalOutpoint(built.final.arkTx),
      payoutAddress: playerWins ? game.player!.changeAddress! : game.creator!.changeAddress!,
      houseAddress: game.creator!.changeAddress!,
      rake: 0,
    })
    const before = await vtxoTotal(winnerW)
    await submit({
      arkProvider, arkTx: claim.arkTx, checkpoints: claim.checkpoints,
      signers: [{ identity: winnerId, inputs: [0] }],
      conditionWitness: { index: 0, data: [creatorSecret, playerSecret] },
    })
    await sleep(6000)
    const after = await vtxoTotal(winnerW)
    console.log(`[spike] winner=${winner} total before claim: ${before} after: ${after}`)
    return { before, after }
  }

  it('house win: the player stake is escrowed and paid to the house', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const { before, after } = await runGame(false)
    // House claims the full pot (2x bet) — its own stake back plus the player's.
    expect(after - before).toBeGreaterThanOrEqual(BET * 2 - 100)
  }, 300_000)

  it('player win: the house stake is escrowed and paid to the player', async () => {
    if (!arkAvailable) { console.warn('ark unavailable — skipped'); return }
    const { before, after } = await runGame(true)
    expect(after - before).toBeGreaterThanOrEqual(BET * 2 - 100)
  }, 300_000)
})
