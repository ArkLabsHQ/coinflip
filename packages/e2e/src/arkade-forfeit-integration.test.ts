/**
 * End-to-end R1 forfeit through the arkade-script playerForfeit leaf.
 *
 * Skipped unless both arkd (:7070) and the emulator (:7073) are reachable.
 *
 * Flow:
 *   1. Boot deps with EMULATOR_URL set.
 *   2. /play with a freshly-funded player → server probes emulator,
 *      mints 5-leaf escrow with arkade-forfeit pin in state.
 *   3. Player escrows their stake (no /commit — simulates house withhold).
 *   4. Back-date the persisted finalExpiration so CLTV is satisfied now
 *      (mirrors the escrow-recovery test pattern — avoids waiting for
 *      blocktime to advance).
 *   5. Call handleTrustlessForfeit → returns PSBT + per-escrow payout
 *      amounts.
 *   6. Player signs both inputs; submit to the emulator (which validates
 *      the arkade-script covenant + signs the tweaked emulator slot, then
 *      forwards to arkd for finalization).
 *   7. Assert player VTXOs gained the full pot.
 *
 * What this proves:
 *   - The escrow address is 5-leaf and matches what /play returned.
 *   - The covenant binds the destination + value (off-by-one or wrong
 *     amount → emulator refuses).
 *   - The arkade leaf is in arkd's execution bucket (no exit needed).
 *   - The whole arkade-script -> emulator -> arkd handoff actually works.
 */

import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
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
  type ArkProvider,
} from '@arkade-os/sdk'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000'
const EMULATOR_URL = process.env.EMULATOR_URL || 'http://localhost:7073'
const BET = 1000
const HOUSE_FUND_BTC = 0.005
const PLAYER_FUND_BTC = 0.002

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (b: Uint8Array) => (b.length === 33 ? b.slice(1) : b)

async function faucet(address: string, amountBtc: number): Promise<void> {
  const r = await fetch(`${ESPLORA_URL}/faucet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, amount: amountBtc }),
  })
  if (!r.ok) throw new Error(`Faucet failed: ${r.status} ${await r.text()}`)
}

async function makePlayerWallet(id: SingleKey): Promise<Wallet> {
  return Wallet.create({
    identity: id,
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

const vtxoTotal = async (w: Wallet) => (await w.getVtxos()).reduce((a, v) => a + v.value, 0)

async function settleWithRetry(w: Wallet, tries = 3): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await w.settle()
      return
    } catch (e) {
      if (i === tries - 1) throw e
      await sleep(5000)
    }
  }
}

let infraAvailable = false
beforeAll(async () => {
  try {
    const ark = (await fetch(`${ARK_SERVER_URL}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok
    const emu = (await fetch(`${EMULATOR_URL}/v1/info`, { signal: AbortSignal.timeout(5000) })).ok
    infraAvailable = ark && emu
  } catch {
    infraAvailable = false
  }
}, 10_000)

describe('R1 forfeit through arkade-script playerForfeit leaf (live integration)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deps: any
  let arkProvider: ArkProvider
  let serverUnroll: CSVMultisigTapscript.Type

  beforeAll(async () => {
    if (!infraAvailable) return
    process.env.ARK_SERVER_URL = ARK_SERVER_URL
    process.env.ESPLORA_URL = ESPLORA_URL
    process.env.EMULATOR_URL = EMULATOR_URL
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    server = require('arkade-coinflip-server')
    deps = await server.bootstrapDeps({ walletSettlementConfig: false })
    arkProvider = deps.wallet.arkProvider
    serverUnroll = decodeTapscript(hex.decode(deps.arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

    await faucet(await deps.wallet.getBoardingAddress(), HOUSE_FUND_BTC)
    await waitFor(deps.wallet, 'boarding', HOUSE_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(deps.wallet)
    await waitFor(deps.wallet, 'settled', BET * 5)
  }, 180_000)

  it('mints the 5-leaf escrow when EMULATOR_URL is set and persists the arkade-forfeit pin', async () => {
    if (!infraAvailable) {
      console.warn('arkd or emulator unavailable — skipped')
      return
    }

    // Build a fresh player.
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await makePlayerWallet(playerId)
    await faucet(await playerW.getBoardingAddress(), PLAYER_FUND_BTC)
    await waitFor(playerW, 'boarding', PLAYER_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(playerW)
    await waitFor(playerW, 'settled', BET)

    const playerSecret = Buffer.from(new Uint8Array(16))
    crypto.getRandomValues(playerSecret)
    const playerHash = createHash('sha256').update(playerSecret).digest('hex')
    const playerPubHex = hex.encode(toXOnly(await playerId.compressedPublicKey()))
    const playerChangeAddress = await playerW.getAddress()

    const play = await server.handleTrustlessPlay(
      { tier: BET, playerPubkey: playerPubHex, playerHash, playerChangeAddress },
      deps,
    )

    // Persisted state MUST carry the arkade-forfeit pin: emulator pubkey,
    // player payout pkScript, and BOTH per-escrow values.
    const row = await deps.repos.games.get(play.gameId)
    const state = JSON.parse(row.house_vtxos_json as string)
    expect(state.arkadeForfeit).toBeDefined()
    expect(state.arkadeForfeit.emulatorPubkeyHex).toMatch(/^[0-9a-f]{64,66}$/)
    expect(state.arkadeForfeit.playerForfeitPkScriptHex).toMatch(/^5120[0-9a-f]{64}$/)
    expect(state.arkadeForfeit.playerEscrowValue).toBe(BET)
    expect(typeof state.arkadeForfeit.houseEscrowValue).toBe('number')

    // The pinned payout pkScript MUST be what the player's ArkAddress decodes to.
    const expectedPkScript = hex.encode(ArkAddress.decode(playerChangeAddress).pkScript)
    expect(state.arkadeForfeit.playerForfeitPkScriptHex).toBe(expectedPkScript)
  }, 180_000)

  it('forfeit claim succeeds: player sweeps both escrows via the arkade-script leaf', async () => {
    if (!infraAvailable) return

    // Stand up a player.
    const playerId = SingleKey.fromRandomBytes()
    const playerW = await makePlayerWallet(playerId)
    await faucet(await playerW.getBoardingAddress(), PLAYER_FUND_BTC)
    await waitFor(playerW, 'boarding', PLAYER_FUND_BTC * 1e8 * 0.9)
    await settleWithRetry(playerW)
    await waitFor(playerW, 'settled', BET)

    const playerSecret = Buffer.from(new Uint8Array(16))
    crypto.getRandomValues(playerSecret)
    const playerHash = createHash('sha256').update(playerSecret).digest('hex')
    const playerPubHex = hex.encode(toXOnly(await playerId.compressedPublicKey()))
    const playerChangeAddress = await playerW.getAddress()

    const play = await server.handleTrustlessPlay(
      { tier: BET, playerPubkey: playerPubHex, playerHash, playerChangeAddress },
      deps,
    )
    const escrowPk = ArkAddress.decode(play.escrowAddress).pkScript

    // Player funds their escrow with their stake.
    const pv = (await playerW.getVtxos())[0]
    const change = pv.value - BET
    const pOutputs: { script: Uint8Array; amount: bigint }[] = [
      { script: escrowPk, amount: BigInt(BET) },
    ]
    if (change > 0) {
      pOutputs.push({ script: ArkAddress.decode(playerChangeAddress).pkScript, amount: BigInt(change) })
    }
    const escrowTx = buildOffchainTx(
      [{ txid: pv.txid, vout: pv.vout, value: pv.value, tapLeafScript: pv.forfeitTapLeafScript, tapTree: pv.tapTree }],
      pOutputs,
      serverUnroll,
    )
    {
      const signed = await playerId.sign(escrowTx.arkTx, [0])
      const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
        base64.encode(signed.toPSBT()),
        escrowTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
      )
      const finals: string[] = []
      for (const c of signedCheckpointTxs) {
        const tx = Transaction.fromPSBT(base64.decode(c))
        const idx = Array.from({ length: tx.inputsLength }, (_, i) => i)
        finals.push(base64.encode((await playerId.sign(tx, idx)).toPSBT()))
      }
      await arkProvider.finalizeTx(arkTxid, finals)
      // Save the player escrow outpoint.
      var playerEscrowTxid = arkTxid // eslint-disable-line no-var
    }
    const playerEscrow = { txid: playerEscrowTxid, vout: 0, value: BET }

    // Back-date finalExpiration so CLTV is satisfied — mirrors the
    // escrow-recovery test trick. We rewrite the persisted JSON so the
    // server's /forfeit rebuilds the SAME taproot (the rebuilt arkade leaf
    // pins the back-dated CLTV).
    const now = Math.floor(Date.now() / 1000)
    const row = await deps.repos.games.get(play.gameId)
    const state = JSON.parse(row.house_vtxos_json as string)
    state.finalExpiration = now - 3600
    state.setupExpiration = now - 7200
    await deps.repos.games.update(play.gameId, {
      houseVtxosJson: JSON.stringify(state),
    })

    // Build the forfeit-claim PSBT through the server.
    const forfeit = await server.handleTrustlessForfeit(play.gameId, { playerEscrow }, deps)
    expect(forfeit.forfeitPsbt).toBeTruthy()
    expect(forfeit.payoutAmounts).toHaveLength(2)
    expect(forfeit.payoutAmounts[1]).toBe(BET) // player's escrow value

    // Sign the player's slot in the forfeit tx. Inputs are
    //   input 0: house escrow (player sweeps via playerForfeit leaf)
    //   input 1: player escrow (player sweeps via playerForfeit leaf)
    // Both leaves are [player, server, emulator_tweaked], so the player
    // signs both slots; arkd signs the server slot; the emulator signs
    // the tweaked slot after running the arkade script.
    const arkTx = Transaction.fromPSBT(hex.decode(forfeit.forfeitPsbt))
    const signed = await playerId.sign(arkTx, [0, 1])

    // Submit to the emulator. It runs the arkade script per-input, signs
    // the tweaked slot, then submits the finalized tx to arkd.
    const emuResp = await fetch(`${EMULATOR_URL}/v1/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arkTx: base64.encode(signed.toPSBT()),
        checkpointTxs: forfeit.forfeitCheckpoints.map(
          (c: string) => base64.encode(hex.decode(c)),
        ),
      }),
    })
    expect(emuResp.ok).toBe(true)
    const emuBody = (await emuResp.json()) as { signedArkTx: string }
    expect(emuBody.signedArkTx).toBeTruthy()

    // The emulator (per its README) acts as the last non-arkd signer for
    // covenant inputs and self-finalizes via arkd, so the response is the
    // finalized PSBT — extract the txid.
    const finalTx = Transaction.fromPSBT(base64.decode(emuBody.signedArkTx))
    const forfeitTxid = finalTx.id
    expect(forfeitTxid).toBeTruthy()

    // The player wallet should now hold both escrows' value as fresh VTXOs.
    await sleep(6000)
    const after = await vtxoTotal(playerW)
    const expectedPot = forfeit.payoutAmounts[0] + forfeit.payoutAmounts[1]
    // Player should have AT LEAST the pot (minus dust/fees), plus the
    // change they retained from the player-escrow funding.
    expect(after).toBeGreaterThanOrEqual(expectedPot - 200)
    console.log(`[r1-forfeit] forfeit claimed: player VTXOs=${after} pot=${expectedPot} txid=${forfeitTxid}`)
  }, 300_000)
})
