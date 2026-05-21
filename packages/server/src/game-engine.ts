import { v4 as uuidv4 } from 'uuid'
import { createHash, randomBytes } from 'crypto'
import { hex } from '@scure/base'
import {
  generateSecret,
  determineWinner,
  buildGameTransactions,
  coinSelect,
  getSetupScript,
  getFinalScript,
  getSetupAddress,
  getFinalAddress,
  type Game,
  type VtxoInput,
} from 'arkade-coinflip'
import { isVtxoExpiringSoon, VtxoScript, type ExtendedVirtualCoin } from '@arkade-os/sdk'
import { hashSecret, networkHrpFromArkInfo } from './house-wallet.js'
import { createGameContracts, markGameContractsInactive } from './contract-manager.js'
import type { AppDeps } from './deps.js'

export interface PlayRequest {
  tier: number
  choice: 'heads' | 'tails'
  playerPubkey: string
  playerHash: string
  playerVtxos: VtxoInput[]
  playerChangeAddress: string
}

export interface PlayResult {
  gameId: string
  housePubkey: string
  houseHash: string
  setupTxHex: string
  finalTxHex: string
  /** Checkpoint PSBTs for the setup tx — one per input. Required to submit. */
  setupCheckpointsHex: string[]
  /** Checkpoint PSBTs for the final tx — one for the single setup-spend input. */
  finalCheckpointsHex: string[]
  houseSetupSignatures: string[]
  houseFinalSignature: string
}

export interface SignRequest {
  playerSetupSignatures: string[]
  playerFinalSignature: string
  playerSecretHex: string
  playerChangeAddress?: string
}

export interface SignResult {
  winner: 'house' | 'player'
  houseSecret: string
  playerSecret: string
  houseSecretSize: number
  playerSecretSize: number
  payout: number
  rake: number
  proof: string
  txid: string
}

async function getTiers(deps: AppDeps): Promise<number[]> {
  const tiersStr = (await deps.repos.config.get('tiers')) || '[1000,5000,10000,50000]'
  return JSON.parse(tiersStr)
}

async function getRake(deps: AppDeps): Promise<{ type: 'percentage' | 'flat'; value: number }> {
  const rakeType = ((await deps.repos.config.get('rake_type')) || 'percentage') as 'percentage' | 'flat'
  const rakeValue = parseInt((await deps.repos.config.get('rake_value')) || '2', 10)
  return { type: rakeType, value: rakeValue }
}

async function calculateRake(potAmount: number, deps: AppDeps): Promise<number> {
  const rake = await getRake(deps)
  let rakeAmount: number

  if (rake.type === 'percentage') {
    rakeAmount = Math.floor(potAmount * rake.value / 100)
  } else {
    rakeAmount = rake.value
  }

  // Waive if it would push payout below dust (546 sats)
  if (potAmount - rakeAmount < 546) {
    return 0
  }

  return rakeAmount
}

/**
 * Convert SDK ExtendedVirtualCoin to lib VtxoInput.
 *
 * Two non-obvious bits at play:
 *   (1) `intentTapLeafScript[1]` is the raw script with the Taproot
 *       leaf-version byte (0xc0) appended. `VtxoScript`'s constructor
 *       re-appends the version byte when it builds the tap tree, so we
 *       must strip the trailing byte here — otherwise we end up with
 *       `<script><0xc0><0xc0>` and `Unknown opcode=c0` downstream.
 *   (2) The wallet VTXO's pkScript depends on *every* leaf in its tap
 *       tree, not just the one we plan to spend through. If we only put
 *       the intent leaf into `tapscripts`, `vtxoInputToArkTxInput` in
 *       the lib reconstructs a smaller tree → a different pkScript →
 *       arkd's submitTx rejects with `VTXO_NOT_FOUND` because the
 *       (txid, vout) doesn't point at an indexed output with that
 *       script. Decode the full `tapTree` from the VTXO and ship every
 *       leaf along; `leaf` still identifies the one we want to spend.
 */
function vtxoToInput(vtxo: ExtendedVirtualCoin): VtxoInput {
  const fullScript = VtxoScript.decode(vtxo.tapTree)
  const tapscripts = fullScript.scripts.map((s) => hex.encode(s))
  // Use the forfeit leaf, not the intent leaf. The wallet exposes both:
  // `intentTapLeafScript` is used when joining a settlement batch round
  // (where arkd renews the VTXO into the tree), and `forfeitTapLeafScript`
  // is used when spending through the regular offchain-tx path that
  // `arkProvider.submitTx` handles. The trustless coinflip fallback path
  // goes through submitTx, so we want the forfeit leaf here.
  const forfeitScript = vtxo.forfeitTapLeafScript[1].slice(0, -1)
  const leafHex = hex.encode(forfeitScript)
  return {
    vtxo: {
      outpoint: { txid: vtxo.txid, vout: vtxo.vout },
      amount: vtxo.value.toString(),
      tapscripts,
    },
    leaf: leafHex,
  }
}

/**
 * Minimum remaining VTXO lifetime when selecting house VTXOs for a new
 * game. The fallback path requires the input VTXO to remain spendable
 * up to `setupExpiration` (10 min) plus a safety margin for the Ark
 * server's settlement round.
 */
export const VTXO_LIFETIME_BUFFER_MS = 30 * 60_000

/**
 * Drop VTXOs that would expire before the fallback's final tx window has
 * a chance to settle. The wallet's auto-renewal loop *should* keep these
 * out of `getVtxos()` already, but we filter explicitly so a broken
 * renewal config can't silently poison a game.
 *
 * Exported for unit testing.
 */
export function selectableHouseVtxos(
  vtxos: ExtendedVirtualCoin[],
  bufferMs = VTXO_LIFETIME_BUFFER_MS,
): { selectable: ExtendedVirtualCoin[]; dropped: ExtendedVirtualCoin[] } {
  const selectable: ExtendedVirtualCoin[] = []
  const dropped: ExtendedVirtualCoin[] = []
  for (const v of vtxos) {
    if (isVtxoExpiringSoon(v, bufferMs)) {
      dropped.push(v)
    } else {
      selectable.push(v)
    }
  }
  return { selectable, dropped }
}

/**
 * Try to renew house VTXOs by joining a settlement batch. Returns true if
 * a settle round was triggered, false if the wallet has no expiring VTXOs
 * to renew. Called from `handlePlay` when the selectable house balance
 * would otherwise be insufficient.
 */
export async function renewExpiringHouseVtxos(deps: AppDeps): Promise<boolean> {
  const all = await deps.wallet.getVtxos()
  const { dropped } = selectableHouseVtxos(all)
  if (dropped.length === 0) return false
  console.log(`[house wallet] renewing ${dropped.length} expiring VTXOs via settle()`)
  await deps.wallet.settle()
  return true
}

/**
 * Handle a play request: house generates secret, builds game transactions,
 * signs the house's inputs, and returns everything to the player.
 *
 * The transactions serve as the trustless fallback — if either party
 * disappears, the other can use them to claim on-chain via the abort path.
 * The happy path uses a simple Ark payment after winner determination.
 */
export async function handlePlay(req: PlayRequest, deps: AppDeps): Promise<PlayResult> {
  const tiers = await getTiers(deps)
  if (!tiers.includes(req.tier)) {
    throw new Error(`Invalid tier: ${req.tier}. Available: ${tiers.join(', ')}`)
  }

  // Validate player inputs
  if (!req.playerVtxos || req.playerVtxos.length === 0) {
    throw new Error('Player must provide VTXOs')
  }
  if (!req.playerChangeAddress) {
    throw new Error('Player must provide a change address')
  }

  // Check house balance from real wallet
  const balance = await deps.wallet.getBalance()
  const available = balance.available
  if (available < req.tier) {
    throw new Error(`House balance insufficient. Available: ${available}, needed: ${req.tier}`)
  }

  // Rate limit: max 3 pending per player
  const pendingCount = await deps.repos.games.countPendingForPlayer(req.playerPubkey)
  if (pendingCount >= 3) {
    throw new Error('Too many pending games. Complete or wait for existing games to expire.')
  }

  // House is the creator — generate secret (CSPRNG for choice)
  const houseChoice: 'heads' | 'tails' = randomBytes(1)[0] < 128 ? 'heads' : 'tails'
  const houseSecret = generateSecret(houseChoice)
  const houseHash = hashSecret(houseSecret)

  const gameId = uuidv4()
  const houseXOnly = await deps.identity.xOnlyPublicKey()
  const housePubkey = Buffer.from(await deps.identity.compressedPublicKey()).toString('hex')
  const networkHrp = networkHrpFromArkInfo(deps.arkInfo)

  // Select house VTXOs for the bet, filtering out anything that would
  // expire before the trustless-fallback window closes. If filtering
  // leaves us short of the tier amount, try renewing via batch settle()
  // once before giving up — the wallet's auto-renewal might be disabled
  // or stuck on a fee-config issue.
  let allHouseVtxos = await deps.wallet.getVtxos()
  let { selectable: usableHouseVtxos, dropped } =
    selectableHouseVtxos(allHouseVtxos)
  let usableSum = usableHouseVtxos.reduce((acc, v) => acc + v.value, 0)
  if (usableSum < req.tier && dropped.length > 0) {
    await renewExpiringHouseVtxos(deps)
    allHouseVtxos = await deps.wallet.getVtxos()
    ;({ selectable: usableHouseVtxos } = selectableHouseVtxos(allHouseVtxos))
    usableSum = usableHouseVtxos.reduce((acc, v) => acc + v.value, 0)
  }
  if (usableSum < req.tier) {
    throw new Error(
      `House balance insufficient after expiry filter. Usable: ${usableSum}, needed: ${req.tier}`,
    )
  }
  const houseVtxoInputs = usableHouseVtxos.map(vtxoToInput)
  const { inputs: selectedHouseVtxos } = coinSelect(houseVtxoInputs, BigInt(req.tier))
  if (!selectedHouseVtxos) {
    throw new Error('Could not select enough house VTXOs for the bet')
  }

  // Get house change address
  const houseChangeAddress = await deps.wallet.getAddress()

  // Build the Game object for the lib
  const playerPubBytes = hex.decode(req.playerPubkey)
  const now = Math.floor(Date.now() / 1000)

  // Server pubkey from Ark info (x-only, 32 bytes)
  const signerPub = hex.decode(deps.arkInfo.signerPubkey)
  const serverPubkey = signerPub.length === 33 ? signerPub.slice(1) : signerPub

  const game: Game = {
    gameId,
    betAmount: BigInt(req.tier),
    serverPubkey,
    setupExpiration: now + 600, // 10 min
    finalExpiration: now + 1200, // 20 min
    creator: {
      pubkey: houseXOnly,
      hash: hex.decode(houseHash),
      vtxos: selectedHouseVtxos,
      changeAddress: houseChangeAddress,
    },
    player: {
      pubkey: playerPubBytes.length === 33 ? playerPubBytes.slice(1) : playerPubBytes,
      hash: hex.decode(req.playerHash),
      vtxos: req.playerVtxos,
      changeAddress: req.playerChangeAddress,
    },
  }

  // Build setup and final transactions using the lib. Each `BuiltOffchainTx`
  // carries its own checkpoint chain alongside the ark tx — both halves are
  // needed to actually submit through `arkProvider.submitTx(...)` if the
  // player ever exercises the trustless fallback.
  const built = buildGameTransactions(game, deps.arkInfo, networkHrp)

  // Sign setup transaction (house's VTXO inputs) with house identity
  const houseInputIndices = selectedHouseVtxos.map((_, i) => i)
  const signedSetup = await deps.identity.sign(built.setup.arkTx, houseInputIndices)

  // Sign final transaction (house as creator signs the reveal leaf on input 0)
  const signedFinal = await deps.identity.sign(built.final.arkTx, [0])

  // Extract house signatures for the player
  const houseSetupSignatures: string[] = []
  for (const i of houseInputIndices) {
    const input = signedSetup.getInput(i)
    const sigs = input.tapScriptSig
    if (sigs && sigs.length > 0) {
      houseSetupSignatures.push(hex.encode(sigs[sigs.length - 1][1]))
    }
  }

  const finalInput = signedFinal.getInput(0)
  const finalSigs = finalInput.tapScriptSig
  const houseFinalSig = finalSigs && finalSigs.length > 0
    ? hex.encode(finalSigs[finalSigs.length - 1][1])
    : ''

  // Serialize transactions as PSBT (hex). Checkpoint PSBTs go alongside so
  // the fallback chain is fully submittable.
  const setupTxHex = hex.encode(signedSetup.toPSBT())
  const finalTxHex = hex.encode(signedFinal.toPSBT())
  const setupCheckpointsHex = built.setup.checkpoints.map((c) => hex.encode(c.toPSBT()))
  const finalCheckpointsHex = built.final.checkpoints.map((c) => hex.encode(c.toPSBT()))

  // Derive contract scripts/addresses so we can register them with the SDK
  // ContractManager (and persist them on the game row for later lookup).
  const setupVtxoScript = getSetupScript(game)
  const finalVtxoScript = getFinalScript(game)
  const setupAddress = getSetupAddress(game, networkHrp)
  const finalAddress = getFinalAddress(game, networkHrp)
  const setupScriptHex = hex.encode(setupVtxoScript.pkScript)
  const finalScriptHex = hex.encode(finalVtxoScript.pkScript)

  // Store game in DB. Checkpoint PSBT hex is JSON-encoded so the player can
  // reconstruct the full submit-tx chain from the row alone if needed.
  await deps.repos.games.save({
    id: gameId,
    tier: req.tier,
    playerPubkey: req.playerPubkey,
    playerChoice: req.choice,
    playerHash: req.playerHash,
    playerChangeAddress: req.playerChangeAddress,
    houseSecretHex: Buffer.from(houseSecret).toString('hex'),
    setupTxHex,
    finalTxHex,
    setupScriptHex,
    finalScriptHex,
    setupCheckpointsJson: JSON.stringify(setupCheckpointsHex),
    finalCheckpointsJson: JSON.stringify(finalCheckpointsHex),
  })

  // Register both contracts as `active` so the watcher fires if a player ever
  // broadcasts the trustless-fallback setup/final tx. Failures here mustn't
  // block the play response — the game is still tradeable via the synchronous
  // happy path; the contract subsystem is purely defensive plumbing.
  try {
    await createGameContracts(deps, {
      gameId,
      setup: {
        params: {
          creatorPubkey: game.creator!.pubkey!,
          playerPubkey: game.player!.pubkey!,
          serverPubkey: game.serverPubkey!,
          creatorHash: game.creator!.hash!,
          setupExpiration: BigInt(game.setupExpiration!),
        },
        script: setupScriptHex,
        address: setupAddress.encode(),
      },
      final: {
        params: {
          creatorPubkey: game.creator!.pubkey!,
          playerPubkey: game.player!.pubkey!,
          serverPubkey: game.serverPubkey!,
          creatorHash: game.creator!.hash!,
          playerHash: game.player!.hash!,
          finalExpiration: BigInt(game.finalExpiration!),
        },
        script: finalScriptHex,
        address: finalAddress.encode(),
      },
    })
  } catch (err) {
    console.warn(`[game ${gameId}] createGameContracts failed: ${err instanceof Error ? err.message : err}`)
  }

  return {
    gameId,
    housePubkey,
    houseHash,
    setupTxHex,
    finalTxHex,
    setupCheckpointsHex,
    finalCheckpointsHex,
    houseSetupSignatures,
    houseFinalSignature: houseFinalSig,
  }
}

/**
 * Handle sign request: player reveals their secret, server determines winner,
 * and settles the game by sending the payout via a normal Ark payment.
 */
export async function handleSign(gameId: string, req: SignRequest, deps: AppDeps): Promise<SignResult> {
  const game = await deps.repos.games.get(gameId)
  if (!game) throw new Error(`Game not found: ${gameId}`)
  if (game.status !== 'pending') throw new Error(`Game is not pending: ${game.status}`)

  // Validate player secret matches their committed hash
  const playerSecret = Buffer.from(req.playerSecretHex, 'hex')
  const playerHash = createHash('sha256').update(playerSecret).digest('hex')
  if (playerHash !== game.player_hash) {
    throw new Error('Player secret does not match committed hash')
  }

  // Determine winner
  const houseSecret = Buffer.from(game.house_secret_hex, 'hex')
  const winnerRole = determineWinner(
    new Uint8Array(houseSecret),
    new Uint8Array(playerSecret),
  )

  // Map creator → house
  const winner: 'house' | 'player' = winnerRole === 'creator' ? 'house' : 'player'

  const potAmount = game.tier * 2
  const rakeAmount = await calculateRake(potAmount, deps)
  const payoutAmount = potAmount - rakeAmount

  // Build proof string
  const houseSecretSize = houseSecret.length
  const playerSecretSize = playerSecret.length
  const houseSide = houseSecretSize === 15 ? 'heads' : 'tails'
  const playerSide = playerSecretSize === 15 ? 'heads' : 'tails'
  const sameSize = houseSecretSize === playerSecretSize
  const proof = `House secret: ${houseSecretSize} bytes (${houseSide}). ` +
    `Player secret: ${playerSecretSize} bytes (${playerSide}). ` +
    `${sameSize ? 'Same size' : 'Different sizes'} → ${winner} wins.` +
    `${winner === 'player' ? ` Player chose ${game.player_choice}, secret is ${playerSide}. ${game.player_choice === playerSide ? 'Correct call.' : 'Determined by secret size.'}` : ''}`

  // Settle the game: send payout to winner via Ark
  let txid = ''
  try {
    if (winner === 'player') {
      const payoutAddress = game.player_change_address
      if (!payoutAddress) {
        throw new Error('No player change address stored — cannot send payout')
      }
      txid = await deps.wallet.sendBitcoin({
        address: payoutAddress,
        amount: payoutAmount,
      })
      console.log(`Player won game ${gameId}. Payout ${payoutAmount} sats, txid: ${txid}`)
    } else {
      console.log(`House won game ${gameId}. Kept ${game.tier} sats (player's bet).`)
      txid = 'house-win-no-transfer'
    }
  } catch (err) {
    console.error(`Failed to settle game ${gameId}:`, err)
  }

  // Update game in DB
  await deps.repos.games.update(gameId, {
    playerSecretHex: req.playerSecretHex,
    winner,
    rakeAmount,
    payoutAmount,
    status: 'resolved',
  })

  // Stop the watcher polling the (now-defunct) coinflip-setup / coinflip-final
  // addresses for this game.
  await markGameContractsInactive(deps, game.setup_script_hex, game.final_script_hex)

  return {
    winner,
    houseSecret: game.house_secret_hex,
    playerSecret: req.playerSecretHex,
    houseSecretSize,
    playerSecretSize,
    payout: payoutAmount,
    rake: rakeAmount,
    proof,
    txid,
  }
}

// Cleanup expired pending games every 60 seconds
export function startExpiryTimer(deps: AppDeps): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const { expired, rows } = await deps.repos.games.expirePending(5)
      if (expired > 0) {
        console.log(`Expired ${expired} pending games`)
        for (const g of rows) {
          markGameContractsInactive(deps, g.setup_script_hex, g.final_script_hex)
            .catch((err) => console.warn(`[expiry ${g.id}] inactivate failed: ${err}`))
        }
      }
    } catch (err) {
      console.error('Expiry timer error:', err)
    }
  }, 60_000)
}
