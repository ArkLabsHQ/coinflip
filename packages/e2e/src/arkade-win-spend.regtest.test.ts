/**
 * Consensus-critical v0.3 regtest: prove the emulator accepts the v3 covenant
 * sweep with packet-borne reveals, and that the actual on-chain settlement
 * pays the winner.
 *
 * Flow (no coinflip-server used — everything built by hand):
 *   1. Three fresh single-key wallets: player, house, "server" (the signer
 *      that signs the multisig's server slot).
 *   2. Player + house fund their VTXOs (faucet → settle).
 *   3. Construct CoinflipEscrowScriptV3 with chosen (player_digit, creator_digit)
 *      → predicate evaluates winner deterministically.
 *   4. Player sends `BET` sats to the player escrow; house sends `BET` sats to
 *      the house escrow.
 *   5. Build the v3 covenant sweep:
 *        - Both escrow inputs spent via the winner's covenant leaf.
 *        - Server (xonly key in the multisig's server slot) signs.
 *        - Emulator runs the arkade-script (predicate + atomic-sweep covenant),
 *          which reads digits from extension packets via OP_INSPECTPACKET.
 *        - Emu signs, forwards finalized tx to arkd.
 *   6. Mine. Assert: both escrow VTXOs spent, winner's payout address gets
 *      `2 * BET`.
 *
 * Gated by ARK_SERVER_URL availability (matches existing regtest pattern).
 */

/* eslint-disable @typescript-eslint/no-require-imports */
import { base64, hex } from '@scure/base'
import {
  buildOffchainTx,
  decodeTapscript,
  CSVMultisigTapscript,
  Transaction,
  ArkAddress,
  Wallet,
  SingleKey,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  RestArkProvider,
  RestIndexerProvider,
  RestEmulatorProvider,
  type ArkProvider,
  type Identity,
  type IndexerProvider,
} from '@arkade-os/sdk'
import {
  CoinflipEscrowScriptV3,
  CoinflipEscrowV3ContractHandler,
  COINFLIP_ESCROW_V3_TYPE,
  commitDigit,
  digitHash,
  buildCovenantSweepTransactionV3,
  registerCoinflipContracts,
  type DigitCommit,
} from 'arkade-coinflip'
import { contractHandlers } from '@arkade-os/sdk'
import { faucet, mineBlock, sleep } from './helpers'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMULATOR_URL = process.env.EMULATOR_URL || 'http://localhost:7073'

const BET = 1000
const PLAYER_FUND_BTC = 0.002
const HOUSE_FUND_BTC = 0.002
const FINAL_EXPIRATION_BUFFER = 1800  // 30 min — well past any test settlement
const EXIT_DELAY = 86_528n            // BIP68 seconds, multiple of 512

const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)
const p2tr = (xonly: Uint8Array) => new Uint8Array([0x51, 0x20, ...xonly])

async function makeWallet(id: SingleKey): Promise<Wallet> {
  return Wallet.create({
    identity: id as unknown as Identity,
    arkServerUrl: ARK_SERVER_URL,
    esploraUrl: ESPLORA_URL,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlementConfig: false,
  })
}

async function waitFor(w: Wallet, kind: 'boarding' | 'settled', min: number, t = 120_000): Promise<void> {
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
    try {
      await w.settle()
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (i === tries - 1 || !msg.includes('No inputs found')) throw e
      await sleep(5000)
    }
  }
}

/**
 * Single-party submit (the funding party signs all checkpoint slots).
 * Used to escrow a stake into a P2TR address from a single-key wallet.
 */
async function submitSingleParty(
  ark: ArkProvider,
  identity: Identity,
  arkTx: Transaction,
  checkpoints: Transaction[],
  inputIndex = 0,
): Promise<string> {
  const signed = await identity.sign(arkTx, [inputIndex])
  const { arkTxid, signedCheckpointTxs } = await ark.submitTx(
    base64.encode(signed.toPSBT()),
    checkpoints.map((c) => base64.encode(c.toPSBT())),
  )
  const finals: string[] = []
  for (const c of signedCheckpointTxs) {
    const tx = Transaction.fromPSBT(base64.decode(c))
    const idx = Array.from({ length: tx.inputsLength }, (_, i) => i)
    finals.push(base64.encode((await identity.sign(tx, idx)).toPSBT()))
  }
  await ark.finalizeTx(arkTxid, finals)
  return arkTxid
}

let arkAvailable = false
let emuAvailable = false
beforeAll(async () => {
  try {
    arkAvailable = (await fetch(`${ARK_SERVER_URL}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok
  } catch { arkAvailable = false }
  try {
    emuAvailable = (await fetch(`${EMULATOR_URL}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok
  } catch { emuAvailable = false }
}, 10_000)

describe('v0.3 covenant sweep (consensus-critical) — emulator round-trip', () => {
  it('player wins → covenant sweep via playerWinCovenant settles, winner gets pot', async () => {
    if (!arkAvailable || !emuAvailable) {
      console.warn(`[skip] regtest unavailable: arkd=${arkAvailable} emu=${emuAvailable}`)
      return
    }

    // ── Wallets ───────────────────────────────────────────────────────────
    const playerId = SingleKey.fromRandomBytes() as unknown as Identity
    const houseId  = SingleKey.fromRandomBytes() as unknown as Identity
    const serverId = SingleKey.fromRandomBytes() as unknown as Identity   // signs the "server" multisig slot
    const playerW = await makeWallet(playerId as unknown as SingleKey)
    const houseW  = await makeWallet(houseId as unknown as SingleKey)
    const ark = new RestArkProvider(ARK_SERVER_URL) as ArkProvider
    const arkInfo = await ark.getInfo()
    const indexer: IndexerProvider = new RestIndexerProvider(ARK_SERVER_URL)
    const serverUnroll = decodeTapscript(hex.decode(arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

    // Fund player + house in parallel.
    await Promise.all([
      faucet(await playerW.getBoardingAddress(), PLAYER_FUND_BTC),
      faucet(await houseW.getBoardingAddress(), HOUSE_FUND_BTC),
    ])
    await waitFor(playerW, 'boarding', PLAYER_FUND_BTC * 1e8 * 0.9)
    await waitFor(houseW,  'boarding', HOUSE_FUND_BTC  * 1e8 * 0.9)
    await Promise.all([settleWithRetry(playerW), settleWithRetry(houseW)])
    await waitFor(playerW, 'settled', BET)
    await waitFor(houseW,  'settled', BET)

    // ── Game parameters: deterministic player-wins outcome ────────────────
    // n=2 (coin), lo=0, target=1 → player wins iff roll == 0.
    // playerDigit=0, creatorDigit=0 → roll = (0+0) % 2 = 0 → PLAYER WINS.
    const N = 2, TARGET = 1, LO = 0
    const playerReveal: DigitCommit = commitDigit(0, N)
    const creatorReveal: DigitCommit = commitDigit(0, N)
    const playerHash = digitHash(playerReveal)
    const creatorHash = digitHash(creatorReveal)

    // Get emulator pubkey.
    const emuInfo = await (await fetch(`${EMULATOR_URL}/v1/info`)).json() as { signerPubkey: string }
    const emulatorPubkey = hex.decode(emuInfo.signerPubkey)

    const playerXOnly = toXOnly(await playerId.compressedPublicKey() as Uint8Array)
    const houseXOnly  = toXOnly(await houseId.compressedPublicKey()  as Uint8Array)
    const serverXOnly = toXOnly(await serverId.compressedPublicKey() as Uint8Array)
    const playerPayoutAddress = await playerW.getAddress()
    const housePayoutAddress  = await houseW.getAddress()
    const playerPayoutPkScript = ArkAddress.decode(playerPayoutAddress).pkScript
    const housePayoutPkScript  = ArkAddress.decode(housePayoutAddress).pkScript

    const finalExpiration = BigInt(Math.floor(Date.now() / 1000) + FINAL_EXPIRATION_BUFFER)

    const arkdServerPubkey = toXOnly(hex.decode(arkInfo.signerPubkey))
    const baseOpts = {
      creatorPubkey: houseXOnly,
      playerPubkey: playerXOnly,
      serverPubkey: arkdServerPubkey,  // arkd is the "server" cosigner per v2 convention
      creatorHash, playerHash,
      finalExpiration, exitDelay: EXIT_DELAY,
      oddsN: N, oddsTarget: TARGET, oddsLo: LO,
      arkadeForfeit: {
        emulatorPubkey,
        playerPayoutPkScript,
        housePayoutPkScript,
        playerStake: BigInt(BET),
        houseStake: BigInt(BET),
      },
    }
    const playerEscrowScript = new CoinflipEscrowScriptV3({ ...baseOpts, refundPubkey: playerXOnly })
    const houseEscrowScript  = new CoinflipEscrowScriptV3({ ...baseOpts, refundPubkey: houseXOnly })
    const playerEscrowAddr = playerEscrowScript.address('tark', arkdServerPubkey)
    const houseEscrowAddr  = houseEscrowScript.address('tark', arkdServerPubkey)

    // ── Fund both escrows. Return the FINAL ark tx bytes too — the sweep
    //    needs them set via PrevArkTxField for the emu's checkpoint
    //    resolution.
    async function fundEscrow(wallet: Wallet, identity: Identity, escrowAddr: ArkAddress): Promise<{ txid: string }> {
      const vtxos = await wallet.getVtxos()
      const v = vtxos[0]
      const change = v.value - BET
      const outputs: { script: Uint8Array; amount: bigint }[] = [
        { script: escrowAddr.pkScript, amount: BigInt(BET) },
      ]
      if (change > 0) {
        outputs.push({ script: ArkAddress.decode(await wallet.getAddress()).pkScript, amount: BigInt(change) })
      }
      const offchainTx = buildOffchainTx(
        [{ txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript, tapTree: v.tapTree }],
        outputs,
        serverUnroll,
      )
      const txid = await submitSingleParty(ark, identity, offchainTx.arkTx, offchainTx.checkpoints, 0)
      return { txid }
    }

    // Register both escrows as v3 contracts BEFORE funding — so the wallet
    // subscribes arkd to the escrow scripts and tracks the funded VTXOs.
    registerCoinflipContracts(contractHandlers)
    const playerEscrowParams = CoinflipEscrowV3ContractHandler.serializeParams(playerEscrowScript.options)
    const houseEscrowParams  = CoinflipEscrowV3ContractHandler.serializeParams(houseEscrowScript.options)
    for (const [wallet, address, params] of [
      [playerW, playerEscrowAddr.encode(), playerEscrowParams] as const,
      [houseW,  houseEscrowAddr.encode(),  houseEscrowParams] as const,
    ]) {
      const cm = await wallet.getContractManager()
      await cm.createContract({
        type: COINFLIP_ESCROW_V3_TYPE,
        params,
        script: hex.encode(ArkAddress.decode(address).pkScript),
        address,
        state: 'active',
        label: address.slice(0, 12),
      })
    }

    const playerFunding = await fundEscrow(playerW, playerId, playerEscrowAddr)
    const houseFunding  = await fundEscrow(houseW, houseId, houseEscrowAddr)
    const playerEscrow = { txid: playerFunding.txid, vout: 0, value: BET }
    const houseEscrow  = { txid: houseFunding.txid, vout: 0, value: BET }


    // Wait for arkd to index both escrow VTXOs — without this the emulator's
    // checkpoint lookup ("checkpoint not found for input 0") races the
    // finalizeTx → indexer chain.
    async function waitForEscrowIndexed(outpoint: { txid: string; vout: number }) {
      for (let i = 0; i < 30; i++) {
        const { vtxos } = await indexer.getVtxos({ outpoints: [outpoint] })
        if (vtxos.length > 0 && !vtxos[0].isSpent) return
        await sleep(1000)
      }
      throw new Error(`escrow ${outpoint.txid}:${outpoint.vout} not indexed`)
    }
    await Promise.all([
      waitForEscrowIndexed(playerEscrow),
      waitForEscrowIndexed(houseEscrow),
    ])
    console.log(`[v3-regtest] both escrows indexed; player=${playerEscrow.txid.slice(0,16)}… house=${houseEscrow.txid.slice(0,16)}…`)

    // ── Build the v3 covenant sweep ───────────────────────────────────────
    const { arkTx, checkpoints } = buildCovenantSweepTransactionV3(arkInfo, {
      winner: 'player',
      escrows: [
        { script: playerEscrowScript, ...playerEscrow },
        { script: houseEscrowScript,  ...houseEscrow },
      ],
      payoutAddress: playerPayoutAddress,
      potAmount: BigInt(2 * BET),
      playerReveal,
      creatorReveal,
    })


    // Sanity: confirm sweep tx structure links arkTx inputs to checkpoint ids.
    for (let i = 0; i < arkTx.inputsLength; i++) {
      const inp = arkTx.getInput(i)
      const inpHex = inp?.txid ? Buffer.from(inp.txid).toString('hex') : 'undef'
      if (inpHex !== checkpoints[i].id) {
        throw new Error(`arkTx.in[${i}].txid ${inpHex} ≠ checkpoint[${i}].id ${checkpoints[i].id} — mutation after buildOffchainTx broke linkage`)
      }
    }

    // ── Send to emulator via SDK provider (proper normalization + retry) ─
    const emu = new RestEmulatorProvider(EMULATOR_URL)
    const encodedArkTx = base64.encode(arkTx.toPSBT())
    const encodedCheckpoints = checkpoints.map((c) => base64.encode(c.toPSBT()))
    let signedArkTx = ''
    let lastErr = ''
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const out = await emu.submitTx(encodedArkTx, encodedCheckpoints)
        signedArkTx = out.signedArkTx
        if (!signedArkTx) throw new Error('emulator returned no signedArkTx')
        break
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        if (attempt < 7 && /failed to process transaction|VTXO_NOT_FOUND|not found|checkpoint/i.test(lastErr)) {
          await sleep(400 + attempt * 400)
          continue
        }
        throw new Error(`emulator rejected v3 sweep: ${lastErr}`)
      }
    }
    const settled = Transaction.fromPSBT(base64.decode(signedArkTx))
    const settledTxid = settled.id

    await mineBlock(2)

    // ── Verify outcome ────────────────────────────────────────────────────
    // (a) Both escrow VTXOs spent.
    let bothSpent = false
    for (let i = 0; i < 20 && !bothSpent; i++) {
      const { vtxos } = await indexer.getVtxos({
        outpoints: [
          { txid: playerEscrow.txid, vout: playerEscrow.vout },
          { txid: houseEscrow.txid,  vout: houseEscrow.vout },
        ],
      })
      bothSpent = vtxos.length === 2 && vtxos.every((v) => v.isSpent)
      if (!bothSpent) await sleep(2000)
    }
    expect(bothSpent).toBe(true)

    // (b) Player payout received the full pot.
    let potToPlayer = false
    for (let i = 0; i < 20 && !potToPlayer; i++) {
      const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(playerPayoutPkScript)] })
      potToPlayer = vtxos.some((v) => v.value === 2 * BET && !v.isSpent)
      if (!potToPlayer) await sleep(2000)
    }
    expect(potToPlayer).toBe(true)
    console.log(`[v3-regtest] player-wins sweep settled: txid=${settledTxid.slice(0, 16)}…, pot=${2 * BET} to player`)

    // Silence unused (we keep the binding for debug visibility).
    void p2tr; void serverXOnly; void emulatorPubkey
  }, 600_000)
})
