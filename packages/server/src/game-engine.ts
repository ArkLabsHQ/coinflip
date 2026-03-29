import { v4 as uuidv4 } from 'uuid'
import { createHash } from 'crypto'
import {
  generateSecret,
  determineWinner,
} from 'arkade-coinflip'
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
  hashSecret,
} from './house-wallet'

export interface PlayRequest {
  tier: number
  choice: 'heads' | 'tails'
  playerPubkey: string
  playerHash: string
  playerVtxos: unknown[]
  playerChangeAddress: string
}

export interface PlayResult {
  gameId: string
  housePubkey: string
  houseHash: string
  setupTx: string
  finalTx: string
  houseSetupSignatures: string[]
  houseFinalSignature: string
}

export interface SignRequest {
  playerSetupSignatures: string[]
  playerFinalSignature: string
  playerSecretHex: string
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

export async function handlePlay(req: PlayRequest): Promise<PlayResult> {
  const tiers = getTiers()
  if (!tiers.includes(req.tier)) {
    throw new Error(`Invalid tier: ${req.tier}. Available: ${tiers.join(', ')}`)
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

  // House is the creator — generate secret
  const houseChoice = Math.random() < 0.5 ? 'heads' : 'tails'
  const houseSecret = generateSecret(houseChoice as 'heads' | 'tails')
  const houseHash = hashSecret(houseSecret)

  const gameId = uuidv4()
  const housePubkey = await getHousePubkeyHex()

  // Store game
  dbCreateGame({
    id: gameId,
    tier: req.tier,
    playerPubkey: req.playerPubkey,
    playerChoice: req.choice,
    playerHash: req.playerHash,
    houseSecretHex: Buffer.from(houseSecret).toString('hex'),
    // TODO: Build real setup/final transactions using lib's buildGameTransactions()
    // Needs: house VTXOs as inputs, player VTXOs, CoinflipSetup/FinalScript, Ark server pubkey
    setupTxHex: 'TODO',
    finalTxHex: 'TODO',
  })

  return {
    gameId,
    housePubkey,
    houseHash,
    setupTx: 'TODO',
    finalTx: 'TODO',
    houseSetupSignatures: [],
    houseFinalSignature: '',
  }
}

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

  // Update game in DB
  updateGame(gameId, {
    playerSecretHex: req.playerSecretHex,
    winner,
    rakeAmount,
    payoutAmount,
    status: 'resolved',
  })

  // TODO: Submit setup tx to Ark server, execute winning final tx path

  return {
    winner,
    houseSecret: game.house_secret_hex,
    playerSecret: req.playerSecretHex,
    houseSecretSize,
    playerSecretSize,
    payout: payoutAmount,
    rake: rakeAmount,
    proof,
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
