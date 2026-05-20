import { v4 as uuidv4 } from 'uuid'
import { createHash, randomBytes } from 'crypto'
import { hex } from '@scure/base'
import {
  generateSecret,
  determineWinner,
  buildGameTransactions,
  coinSelect,
  type Game,
  type VtxoInput,
} from 'arkade-coinflip'
import type { ExtendedVirtualCoin } from '@arkade-os/sdk'
import {
  createGame as dbCreateGame,
  updateGame,
  getGame,
  getConfig,
  getPendingGamesCount,
  expirePendingGames,
} from './db'
import {
  getHouseBalanceSats,
  getHousePubkeyHex,
  getHouseVtxos,
  hashSecret,
  getHouseWalletInstance,
  getHouseIdentity,
  getArkInfo,
  getNetworkHrp,
} from './house-wallet'

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

function getTiers(): number[] {
  const tiersStr = getConfig('tiers') || '[1000,5000,10000,50000]'
  return JSON.parse(tiersStr)
}

function getRake(): { type: 'percentage' | 'flat'; value: number } {
  const rakeType = (getConfig('rake_type') || 'percentage') as 'percentage' | 'flat'
  const rakeValue = parseInt(getConfig('rake_value') || '2', 10)
  return { type: rakeType, value: rakeValue }
}

function calculateRake(potAmount: number): number {
  const rake = getRake()
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

/** Convert SDK ExtendedVirtualCoin to lib VtxoInput */
function vtxoToInput(vtxo: ExtendedVirtualCoin): VtxoInput {
  const leafHex = hex.encode(vtxo.intentTapLeafScript[1])
  return {
    vtxo: {
      outpoint: { txid: vtxo.txid, vout: vtxo.vout },
      amount: vtxo.value.toString(),
      tapscripts: [leafHex],
    },
    leaf: leafHex,
  }
}

/**
 * Handle a play request: house generates secret, builds game transactions,
 * signs the house's inputs, and returns everything to the player.
 *
 * The transactions serve as the trustless fallback — if either party
 * disappears, the other can use them to claim on-chain via the abort path.
 * The happy path uses a simple Ark payment after winner determination.
 */
export async function handlePlay(req: PlayRequest): Promise<PlayResult> {
  const tiers = getTiers()
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
  const available = await getHouseBalanceSats()
  if (available < req.tier) {
    throw new Error(`House balance insufficient. Available: ${available}, needed: ${req.tier}`)
  }

  // Rate limit: max 3 pending per player
  const pendingCount = getPendingGamesCount(req.playerPubkey)
  if (pendingCount >= 3) {
    throw new Error('Too many pending games. Complete or wait for existing games to expire.')
  }

  // House is the creator — generate secret (CSPRNG for choice)
  const houseChoice: 'heads' | 'tails' = randomBytes(1)[0] < 128 ? 'heads' : 'tails'
  const houseSecret = generateSecret(houseChoice)
  const houseHash = hashSecret(houseSecret)

  const gameId = uuidv4()
  const identity = getHouseIdentity()
  const housePubkey = await getHousePubkeyHex()
  const houseXOnly = await identity.xOnlyPublicKey()
  const arkInfo = getArkInfo()
  const networkHrp = getNetworkHrp()

  // Select house VTXOs for the bet
  const allHouseVtxos = await getHouseVtxos()
  const houseVtxoInputs = allHouseVtxos.map(vtxoToInput)
  const { inputs: selectedHouseVtxos } = coinSelect(houseVtxoInputs, BigInt(req.tier))
  if (!selectedHouseVtxos) {
    throw new Error('Could not select enough house VTXOs for the bet')
  }

  // Get house change address
  const wallet = getHouseWalletInstance()
  const houseChangeAddress = await wallet.getAddress()

  // Build the Game object for the lib
  const playerPubBytes = hex.decode(req.playerPubkey)
  const now = Math.floor(Date.now() / 1000)

  // Server pubkey from Ark info (x-only, 32 bytes)
  const signerPub = hex.decode(arkInfo.signerPubkey)
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

  // Build setup and final transactions using the lib
  const { setup, final: finalTx } = buildGameTransactions(game, arkInfo, networkHrp)

  // Sign setup transaction (house's VTXO inputs) with house identity
  // identity.sign(tx, inputIndices) returns a new Transaction with signatures applied
  const houseInputIndices = selectedHouseVtxos.map((_, i) => i)
  const signedSetup = await identity.sign(setup, houseInputIndices)

  // Sign final transaction (house as creator signs the reveal leaf on input 0)
  const signedFinal = await identity.sign(finalTx, [0])

  // Extract house signatures for the player
  const houseSetupSignatures: string[] = []
  for (const i of houseInputIndices) {
    const input = signedSetup.getInput(i)
    const sigs = input.tapScriptSig
    if (sigs && sigs.length > 0) {
      // tapScriptSig is an array of [{ pubKey, leafHash }, signature] pairs
      houseSetupSignatures.push(hex.encode(sigs[sigs.length - 1][1]))
    }
  }

  const finalInput = signedFinal.getInput(0)
  const finalSigs = finalInput.tapScriptSig
  const houseFinalSig = finalSigs && finalSigs.length > 0
    ? hex.encode(finalSigs[finalSigs.length - 1][1])
    : ''

  // Serialize transactions as PSBT
  const setupTxHex = hex.encode(signedSetup.toPSBT())
  const finalTxHex = hex.encode(signedFinal.toPSBT())

  // Store game in DB
  dbCreateGame({
    id: gameId,
    tier: req.tier,
    playerPubkey: req.playerPubkey,
    playerChoice: req.choice,
    playerHash: req.playerHash,
    playerChangeAddress: req.playerChangeAddress,
    houseSecretHex: Buffer.from(houseSecret).toString('hex'),
    setupTxHex,
    finalTxHex,
  })

  return {
    gameId,
    housePubkey,
    houseHash,
    setupTxHex,
    finalTxHex,
    houseSetupSignatures,
    houseFinalSignature: houseFinalSig,
  }
}

/**
 * Handle sign request: player reveals their secret, server determines winner,
 * and settles the game by sending the payout via a normal Ark payment.
 *
 * The signed game transactions (setup + final) remain as trustless fallback —
 * if the house doesn't pay, the player can claim on-chain using the final tx.
 */
export async function handleSign(gameId: string, req: SignRequest): Promise<SignResult> {
  const game = getGame(gameId)
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
    new Uint8Array(playerSecret)
  )

  // Map creator → house
  const winner: 'house' | 'player' = winnerRole === 'creator' ? 'house' : 'player'

  const potAmount = game.tier * 2
  const rakeAmount = calculateRake(potAmount)
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
    const wallet = getHouseWalletInstance()

    if (winner === 'player') {
      // Player won — house sends the payout to the player's Ark address
      const payoutAddress = game.player_change_address
      if (!payoutAddress) {
        throw new Error('No player change address stored — cannot send payout')
      }
      txid = await wallet.sendBitcoin({
        address: payoutAddress,
        amount: payoutAmount,
      })
      console.log(`Player won game ${gameId}. Payout ${payoutAmount} sats, txid: ${txid}`)
    } else {
      // House won — no payment needed, house keeps the pot (minus rake, which it also keeps)
      console.log(`House won game ${gameId}. Kept ${game.tier} sats (player's bet).`)
      txid = 'house-win-no-transfer'
    }
  } catch (err) {
    console.error(`Failed to settle game ${gameId}:`, err)
    // Game still resolves in DB even if settlement fails.
    // The player has the signed transactions as fallback.
  }

  // Update game in DB
  updateGame(gameId, {
    playerSecretHex: req.playerSecretHex,
    winner,
    rakeAmount,
    payoutAmount,
    status: 'resolved',
  })

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
export function startExpiryTimer(): NodeJS.Timeout {
  return setInterval(() => {
    const expired = expirePendingGames(5)
    if (expired > 0) {
      console.log(`Expired ${expired} pending games`)
    }
  }, 60_000)
}
