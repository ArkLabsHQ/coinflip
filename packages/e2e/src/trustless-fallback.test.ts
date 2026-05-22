/**
 * Trustless-fallback + auto-claim e2e.
 *
 * Drives the path the coinflip protocol falls back to when the server
 * refuses to settle: the creator and player co-sign the pre-built
 * setup + final transactions, submit them through `arkProvider.submitTx`
 * / `finalizeTx`, observe the resulting VTXOs at the coinflip-setup
 * and coinflip-final addresses, then trigger `attemptAutoClaim`
 * against the coinflip-final VTXO via the creator-win leaf.
 *
 * Pre-requisite: `buildGameTransactions` now returns checkpoints
 * alongside the ark tx (see `packages/lib/src/transactions.ts` —
 * the older shape discarded them and arkd rejected the submit with
 * "missing checkpoint txs").
 *
 * Skips cleanly when arkade-regtest isn't running.
 */

import { hex, base64 } from '@scure/base'
import { createHash } from 'crypto'
import {
  Wallet,
  SingleKey,
  RestArkProvider,
  RestIndexerProvider,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  ConditionWitness,
  setArkPsbtField,
  Transaction,
  VtxoScript,
  contractHandlers,
  type ArkInfo,
  type ArkProvider,
  type ExtendedVirtualCoin,
  type IndexerProvider,
} from '@arkade-os/sdk'
import {
  buildGameTransactions,
  generateSecret,
  getSetupAddress,
  getFinalAddress,
  registerCoinflipContracts,
  type Game,
  type VtxoInput,
} from 'arkade-coinflip'
import { attemptAutoClaim } from 'arkade-coinflip-server/dist/auto-claim.js'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'
const FUND_BTC = 0.005
const BET = 10_000 // larger bet → more visible balance delta when auto-claim lands

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function sha256(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(b).digest())
}

function toXOnly(b: Uint8Array): Uint8Array {
  return b.length === 33 ? b.slice(1) : b
}

function vtxoToInput(vtxo: ExtendedVirtualCoin): VtxoInput {
  // See server/game-engine.ts:vtxoToInput for the full discussion. Two
  // bits to get right: ship the *full* tap-tree leaves so arkd can
  // match the pkScript, and use the `forfeit` leaf (not `intent`) since
  // the trustless fallback goes through `arkProvider.submitTx`.
  const fullScript = VtxoScript.decode(vtxo.tapTree)
  const tapscripts = fullScript.scripts.map((s) => hex.encode(s))
  const leafHex = hex.encode(vtxo.forfeitTapLeafScript[1].slice(0, -1))
  return {
    vtxo: {
      outpoint: { txid: vtxo.txid, vout: vtxo.vout },
      amount: vtxo.value.toString(),
      tapscripts,
    },
    leaf: leafHex,
  }
}

async function faucet(addr: string, btc: number): Promise<void> {
  const resp = await fetch(`${ESPLORA_URL}/faucet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: addr, amount: btc }),
  })
  if (!resp.ok) throw new Error(`Faucet failed: ${resp.status} ${await resp.text()}`)
}

async function waitFor(test: () => Promise<boolean>, label: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await test()) return
    await sleep(2000)
  }
  throw new Error(`Timeout waiting for: ${label}`)
}

/**
 * Submit a fully-signed ark tx + its checkpoint chain through the Ark
 * provider, then sign every checkpoint input with whichever identities
 * own those inputs (we pass them all in `signers`) and finalize.
 *
 * `identities` is keyed by the x-only pubkey hex of each signer; the
 * function decides which inputs each identity needs to sign by reading
 * the tapScriptSig field arkd writes after `submitTx`.
 */
async function submitAndFinalize(
  arkProvider: ArkProvider,
  signedArkTx: Transaction,
  checkpoints: Transaction[],
  signers: SingleKey[],
  /**
   * Per-input condition witnesses (e.g. the creator secret for the reveal
   * leaf). Indexed by input position. Required on BOTH the ark tx and its
   * corresponding checkpoint — the checkpoint spends the same VTXO through
   * the same leaf, so without it arkd rejects with INVALID_SIGNATURE.
   */
  conditionWitnesses?: (Uint8Array[] | undefined)[],
): Promise<{ arkTxid: string }> {
  const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
    base64.encode(signedArkTx.toPSBT()),
    checkpoints.map((c) => base64.encode(c.toPSBT())),
  )

  // Each checkpoint input may need signatures from one party (setup tx's
  // standard forfeit leaf) OR from multiple (final tx's reveal leaf is
  // a 3-of-3 player+creator+server multisig — arkd signs at submitTx,
  // and we need to accumulate the other two here). Try every signer
  // and keep going past `No taproot scripts signed` errors, which
  // simply mean that signer doesn't hold a key for this input.
  const finalCheckpoints: string[] = []
  for (let cpIdx = 0; cpIdx < signedCheckpointTxs.length; cpIdx++) {
    let tx = Transaction.fromPSBT(base64.decode(signedCheckpointTxs[cpIdx]))
    const indices: number[] = []
    for (let i = 0; i < tx.inputsLength; i++) indices.push(i)
    const cw = conditionWitnesses?.[cpIdx]
    if (cw && cw.length > 0) {
      setArkPsbtField(tx, 0, ConditionWitness, cw)
    }
    let anySigned = false
    for (const signer of signers) {
      try {
        tx = await signer.sign(tx, indices)
        anySigned = true
      } catch (err) {
        if (err instanceof Error && err.message.includes('No taproot scripts signed')) continue
        throw err
      }
    }
    if (!anySigned) throw new Error('No identity could sign checkpoint inputs')
    finalCheckpoints.push(base64.encode(tx.toPSBT()))
  }

  await arkProvider.finalizeTx(arkTxid, finalCheckpoints)
  return { arkTxid }
}

let arkAvailable = false
let arkProvider: ArkProvider
let indexerProvider: IndexerProvider
let arkInfo: ArkInfo

beforeAll(async () => {
  try {
    const resp = await fetch(`${ARK_SERVER_URL}/v1/info`, { signal: AbortSignal.timeout(5000) })
    if (resp.ok) {
      arkAvailable = true
      arkProvider = new RestArkProvider(ARK_SERVER_URL)
      indexerProvider = new RestIndexerProvider(ARK_SERVER_URL)
      arkInfo = await arkProvider.getInfo()
      // Register handlers against our SDK copy so `attemptAutoClaim` can
      // resolve them later.
      registerCoinflipContracts(contractHandlers as unknown as Parameters<typeof registerCoinflipContracts>[0])
    }
  } catch { arkAvailable = false }
}, 15_000)

describe('trustless fallback: submit setup + final, auto-claim from coinflip-final', () => {
  let creatorIdentity: SingleKey
  let playerIdentity: SingleKey
  let creatorWallet: Wallet
  let playerWallet: Wallet
  let creatorSecret: Uint8Array
  let playerSecret: Uint8Array
  let game: Game
  let setupScriptHex: string
  let finalScriptHex: string
  let finalAddressEncoded: string
  let creatorPubHex: string

  beforeAll(async () => {
    if (!arkAvailable) return

    creatorIdentity = SingleKey.fromRandomBytes()
    playerIdentity = SingleKey.fromRandomBytes()

    const mkWallet = (id: SingleKey) =>
      Wallet.create({
        identity: id,
        arkServerUrl: ARK_SERVER_URL,
        esploraUrl: ESPLORA_URL,
        storage: {
          walletRepository: new InMemoryWalletRepository(),
          contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
      })

    creatorWallet = await mkWallet(creatorIdentity)
    playerWallet = await mkWallet(playerIdentity)

    for (const w of [creatorWallet, playerWallet]) {
      const ba = await w.getBoardingAddress()
      await faucet(ba, FUND_BTC)
      // Wait for the *confirmed* boarding UTXO, not just the total. settle()
      // needs at least one confirmed input — if the mempool tx hasn't been
      // mined yet, the call throws "No inputs found".
      await waitFor(
        async () => (await w.getBalance()).boarding.confirmed >= FUND_BTC * 1e8 * 0.9,
        'confirmed boarding',
        90_000,
      )
      // Settle with a retry: arkd's intent pool sometimes hasn't picked up
      // the boarding UTXO even after it's confirmed.
      let settled = false
      for (let attempt = 0; attempt < 3 && !settled; attempt++) {
        try {
          await w.settle()
          settled = true
        } catch (err) {
          if (err instanceof Error && err.message.includes('No inputs found') && attempt < 2) {
            await sleep(5000)
            continue
          }
          throw err
        }
      }
      await waitFor(async () => (await w.getBalance()).settled >= BET, 'settled', 120_000)
    }
  }, 360_000)

  it('submits setup tx via arkProvider with checkpoints, observes coinflip-setup VTXO', async () => {
    if (!arkAvailable) return

    const creatorPub = await creatorIdentity.xOnlyPublicKey()
    const playerPub = await playerIdentity.xOnlyPublicKey()
    const serverPubkey = toXOnly(hex.decode(arkInfo.signerPubkey))
    creatorPubHex = hex.encode(creatorPub)

    creatorSecret = generateSecret('heads') // 15 bytes
    playerSecret = generateSecret('tails')  // 16 bytes
    const creatorHash = sha256(creatorSecret)
    const playerHash = sha256(playerSecret)

    const creatorVtxos = await creatorWallet.getVtxos()
    const playerVtxos = await playerWallet.getVtxos()
    expect(creatorVtxos.length).toBeGreaterThan(0)
    expect(playerVtxos.length).toBeGreaterThan(0)

    const creatorAddr = await creatorWallet.getAddress()
    const playerAddr = await playerWallet.getAddress()
    const now = Math.floor(Date.now() / 1000)
    game = {
      gameId: `fb-${Date.now()}`,
      betAmount: BigInt(BET),
      serverPubkey,
      setupExpiration: now + 600,
      finalExpiration: now + 1200,
      creator: {
        pubkey: creatorPub,
        hash: creatorHash,
        vtxos: [vtxoToInput(creatorVtxos[0])],
        changeAddress: creatorAddr,
      },
      player: {
        pubkey: playerPub,
        hash: playerHash,
        vtxos: [vtxoToInput(playerVtxos[0])],
        changeAddress: playerAddr,
      },
    }

    const setupAddr = getSetupAddress(game, 'tark')
    const finalAddr = getFinalAddress(game, 'tark')
    setupScriptHex = hex.encode(setupAddr.pkScript)
    finalScriptHex = hex.encode(finalAddr.pkScript)
    finalAddressEncoded = finalAddr.encode()

    const built = buildGameTransactions(game, arkInfo, 'tark')
    expect(built.setup.checkpoints.length).toBeGreaterThan(0)
    expect(built.final.checkpoints.length).toBeGreaterThan(0)

    // Sign setup: creator on input 0, player on input 1
    let setupTx = await creatorIdentity.sign(built.setup.arkTx, [0])
    setupTx = await playerIdentity.sign(setupTx, [1])

    const { arkTxid: setupTxid } = await submitAndFinalize(
      arkProvider,
      setupTx,
      built.setup.checkpoints,
      [creatorIdentity, playerIdentity],
    )
    expect(typeof setupTxid).toBe('string')
    console.log(`[fallback] setup submitted, arkTxid=${setupTxid}`)

    // Wait for the setup VTXO to appear at coinflip-setup address
    await waitFor(async () => {
      const res = await indexerProvider.getVtxos({ scripts: [setupScriptHex] })
      return res.vtxos.length > 0
    }, 'coinflip-setup VTXO', 60_000)

    const setupVtxos = (await indexerProvider.getVtxos({ scripts: [setupScriptHex] })).vtxos
    expect(setupVtxos.length).toBeGreaterThan(0)
    expect(setupVtxos.some((v) => v.value === BET * 2)).toBe(true)
    console.log(`[fallback] saw coinflip-setup VTXO: ${setupVtxos[0].txid}:${setupVtxos[0].vout} (${setupVtxos[0].value} sats)`)
  }, 240_000)

  it('submits final tx (reveal leaf with creator secret), observes coinflip-final VTXO', async () => {
    if (!arkAvailable || !game) return

    // Rebuild the final tx fresh; we need to add the condition-witness PSBT
    // field and sign with both identities before submitting. The lib's
    // build already applies whatever signatures `game` knows about, but
    // our game state doesn't yet carry the creator+player signatures.
    const built = buildGameTransactions(game, arkInfo, 'tark')
    const finalArkTx = built.final.arkTx

    // Reveal leaf takes <creatorSecret> as the condition witness.
    setArkPsbtField(finalArkTx, 0, ConditionWitness, [creatorSecret])

    // Sign the reveal leaf — it's 3-of-3 player+creator+server multisig.
    // The server signs at submitTx; player and creator sign here.
    let signedFinal = await creatorIdentity.sign(finalArkTx, [0])
    signedFinal = await playerIdentity.sign(signedFinal, [0])

    const { arkTxid: finalTxid } = await submitAndFinalize(
      arkProvider,
      signedFinal,
      built.final.checkpoints,
      [creatorIdentity, playerIdentity],
      [[creatorSecret]], // single input → single checkpoint → single condition witness
    )
    console.log(`[fallback] final submitted, arkTxid=${finalTxid}`)

    await waitFor(async () => {
      const res = await indexerProvider.getVtxos({ scripts: [finalScriptHex] })
      return res.vtxos.length > 0
    }, 'coinflip-final VTXO', 60_000)

    const finalVtxos = (await indexerProvider.getVtxos({ scripts: [finalScriptHex] })).vtxos
    expect(finalVtxos.length).toBeGreaterThan(0)
    expect(finalVtxos[0].value).toBe(BET * 2)
    console.log(`[fallback] saw coinflip-final VTXO: ${finalVtxos[0].txid}:${finalVtxos[0].vout} (${finalVtxos[0].value} sats)`)
  }, 240_000)

  it('attemptAutoClaim spends the coinflip-final VTXO via creator-win leaf', async () => {
    if (!arkAvailable || !game) return

    // Construct a "Contract" record matching what ContractManager would
    // have persisted, but inline so we don't need a full server boot.
    const params = {
      creator: creatorPubHex,
      player: hex.encode(game.player!.pubkey!),
      server: hex.encode(game.serverPubkey!),
      creatorHash: hex.encode(game.creator!.hash!),
      playerHash: hex.encode(game.player!.hash!),
      finalExpiration: String(game.finalExpiration!),
      creatorSecret: hex.encode(creatorSecret),
      playerSecret: hex.encode(playerSecret),
    }
    const contract = {
      type: 'coinflip-final',
      params,
      script: finalScriptHex,
      address: finalAddressEncoded,
      state: 'active' as const,
      label: `coinflip-final:${game.gameId}`,
      createdAt: Date.now(),
    }

    // Fake game row matching what handlePlay would have saved.
    const gameRow = {
      id: game.gameId!,
      tier: BET,
      player_pubkey: hex.encode(game.player!.pubkey!),
      player_choice: 'tails',
      player_hash: hex.encode(game.player!.hash!),
      player_change_address: game.player!.changeAddress!,
      house_secret_hex: hex.encode(creatorSecret),
      player_secret_hex: hex.encode(playerSecret),
      winner: 'house', // creatorWin → sizes differ (15 vs 16) → creator (house) wins
      rake_amount: 0,
      payout_amount: BET * 2,
      status: 'resolved',
      setup_tx_hex: null,
      final_tx_hex: null,
      setup_script_hex: setupScriptHex,
      final_script_hex: finalScriptHex,
      setup_checkpoints_json: null,
      final_checkpoints_json: null,
      created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      resolved_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    }

    const finalVtxos = (await indexerProvider.getVtxos({ scripts: [finalScriptHex] })).vtxos
    expect(finalVtxos.length).toBeGreaterThan(0)

    // attemptAutoClaim wants ContractVtxo[]; pass through cast since the
    // VirtualCoin shape from the indexer carries all the fields it reads.
    const beforeBalance = (await creatorWallet.getBalance()).total

    process.env.COINFLIP_AUTO_CLAIM = '1'
    const result = await attemptAutoClaim(
      contract as unknown as Parameters<typeof attemptAutoClaim>[0],
      finalVtxos as unknown as Parameters<typeof attemptAutoClaim>[1],
      gameRow as unknown as Parameters<typeof attemptAutoClaim>[2],
      { wallet: creatorWallet, identity: creatorIdentity as unknown as Parameters<typeof attemptAutoClaim>[3]['identity'], arkInfo },
    )

    expect(result.attempted).toBe(true)
    expect(result.path).toBe('creator-win')
    expect(result.arkTxid).toBeTruthy()
    console.log(`[fallback] auto-claim landed, arkTxid=${result.arkTxid}`)

    // Poll creator's wallet for the inbound VTXO.
    await waitFor(async () => (await creatorWallet.getBalance()).total > beforeBalance, 'creator balance up', 60_000)
    const after = await creatorWallet.getBalance()
    expect(after.total).toBeGreaterThan(beforeBalance)
  }, 240_000)
})
