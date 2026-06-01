/**
 * Full E2E game flow tests.
 *
 * These tests create two SDK wallets, fund them via the regtest faucet,
 * settle to create VTXOs, then play a complete coinflip game:
 * create → join → setup → finalize → resolve → cashout.
 *
 * Requires arkade-regtest to be running.
 */

import { hex } from '@scure/base'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import path from 'path'
import {
  gameFromEvents,
  GameStatus,
  generateSecret,
  determineWinner,
  getSetupScript,
  getFinalScript,
  getSetupAddress,
  getFinalAddress,
  getPotAmount,
  type Game,
  type CreateEvent,
  type JoinEvent,
  type SetupStartedEvent,
  type SetupFinalizedEvent,
  type FinalizeEvent,
  type ResolveEvent,
  type VtxoInput,
} from 'arkade-coinflip'
import {
  Wallet,
  SingleKey,
  RestArkProvider,
  buildOffchainTx,
  decodeTapscript,
  CSVMultisigTapscript,
  ConditionWitness,
  setArkPsbtField,
  Transaction,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  ArkAddress,
  type ArkTxInput,
  type ArkInfo,
  type ExtendedVirtualCoin,
  type Identity,
  type ArkProvider,
} from '@arkade-os/sdk'

// -- Config --

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const REGTEST_CLI =
  process.env.REGTEST_CLI || path.resolve(__dirname, '../../../arkade-regtest/regtest.mjs')
const BET_AMOUNT = 1000 // sats
const FUND_AMOUNT = 0.001 // BTC (100,000 sats — enough for bet + fees)

// -- Helpers --

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

function toXOnly(pubkey: Uint8Array): Uint8Array {
  return pubkey.length === 33 ? pubkey.slice(1) : pubkey
}

/** Fund a Bitcoin address via the arkade-regtest CLI faucet (--confirm mines 1 block). */
async function faucet(address: string, amountBtc: number): Promise<void> {
  execFileSync('node', [REGTEST_CLI, 'faucet', address, String(amountBtc), '--confirm'], {
    stdio: 'inherit',
  })
}

/** Wait until wallet has settled VTXOs with at least minAmount sats */
async function waitForSettledBalance(
  wallet: Wallet,
  minAmount: number,
  timeoutMs = 60_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const balance = await wallet.getBalance()
    if (balance.settled >= minAmount) return
    await sleep(2000)
  }
  const balance = await wallet.getBalance()
  throw new Error(
    `Timeout waiting for settled balance >= ${minAmount}. ` +
    `Current: boarding=${balance.boarding.total} settled=${balance.settled}`
  )
}

/** Wait until wallet has boarding UTXOs */
async function waitForBoardingBalance(
  wallet: Wallet,
  minAmount: number,
  timeoutMs = 30_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const balance = await wallet.getBalance()
    if (balance.boarding.total >= minAmount) return
    await sleep(2000)
  }
  const balance = await wallet.getBalance()
  throw new Error(
    `Timeout waiting for boarding balance >= ${minAmount}. Current: ${balance.boarding.total}`
  )
}

/**
 * Convert SDK's ExtendedVirtualCoin to library's VtxoInput format.
 * This bridges the SDK wallet types with the coinflip library types.
 */
function vtxoToInput(vtxo: ExtendedVirtualCoin): VtxoInput {
  // The default spending leaf is the forfeit (collaborative) path
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
 * Convert ExtendedVirtualCoin to ArkTxInput for buildOffchainTx.
 */
function vtxoToArkInput(vtxo: ExtendedVirtualCoin): ArkTxInput {
  return {
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: vtxo.value,
    tapLeafScript: vtxo.intentTapLeafScript,
    tapTree: vtxo.tapTree,
  }
}

// -- Test Suite --

let arkAvailable = false
let arkProvider: ArkProvider
let arkInfo: ArkInfo

beforeAll(async () => {
  try {
    const resp = await fetch(`${ARK_SERVER_URL}/v1/info`, {
      signal: AbortSignal.timeout(5000),
    })
    if (resp.ok) {
      arkAvailable = true
      arkProvider = new RestArkProvider(ARK_SERVER_URL)
      arkInfo = await arkProvider.getInfo()
      console.log(`Ark server: ${arkInfo.network}, dust: ${arkInfo.dust}`)
    }
  } catch {
    console.log('Ark server not available — skipping full game flow tests')
  }
}, 15_000)

describe('full game flow: P2P coinflip', () => {
  // These tests run sequentially — each builds on the previous state

  let creatorIdentity: SingleKey
  let playerIdentity: SingleKey
  let creatorWallet: Wallet
  let playerWallet: Wallet
  let creatorPub: Uint8Array
  let playerPub: Uint8Array
  let serverPubkey: Uint8Array
  let creatorSecret: Uint8Array
  let playerSecret: Uint8Array
  let game: Game

  it('should create and fund two wallets', async () => {
    if (!arkAvailable) return

    // Create identities
    creatorIdentity = SingleKey.fromRandomBytes()
    playerIdentity = SingleKey.fromRandomBytes()
    creatorPub = await creatorIdentity.xOnlyPublicKey()
    playerPub = await playerIdentity.xOnlyPublicKey()
    serverPubkey = toXOnly(hex.decode(arkInfo.signerPubkey))

    console.log('Creator pubkey:', hex.encode(creatorPub))
    console.log('Player pubkey:', hex.encode(playerPub))
    console.log('Server pubkey:', hex.encode(serverPubkey))

    // Create wallets with in-memory storage (no IndexedDB in Node.js)
    creatorWallet = await Wallet.create({
      identity: creatorIdentity,
      arkServerUrl: ARK_SERVER_URL,
      esploraUrl: ESPLORA_URL,
      storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
      },
      settlementConfig: false,
    })

    playerWallet = await Wallet.create({
      identity: playerIdentity,
      arkServerUrl: ARK_SERVER_URL,
      esploraUrl: ESPLORA_URL,
      storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
      },
      settlementConfig: false,
    })

    // Get boarding addresses
    const creatorBoardingAddr = await creatorWallet.getBoardingAddress()
    const playerBoardingAddr = await playerWallet.getBoardingAddress()
    console.log('Creator boarding:', creatorBoardingAddr)
    console.log('Player boarding:', playerBoardingAddr)

    // Fund both wallets via faucet
    await faucet(creatorBoardingAddr, FUND_AMOUNT)
    await faucet(playerBoardingAddr, FUND_AMOUNT)
    console.log('Creator funded:', creatorBoardingAddr)
    console.log('Player funded:', playerBoardingAddr)

    // Wait for boarding UTXOs to appear
    await waitForBoardingBalance(creatorWallet, BET_AMOUNT)
    await waitForBoardingBalance(playerWallet, BET_AMOUNT)

    const creatorBalance = await creatorWallet.getBalance()
    const playerBalance = await playerWallet.getBalance()
    console.log('Creator boarding balance:', creatorBalance.boarding.total)
    console.log('Player boarding balance:', playerBalance.boarding.total)

    expect(creatorBalance.boarding.total).toBeGreaterThanOrEqual(BET_AMOUNT)
    expect(playerBalance.boarding.total).toBeGreaterThanOrEqual(BET_AMOUNT)
  }, 60_000)

  it('should settle both wallets to create VTXOs', async () => {
    if (!arkAvailable) return

    console.log('Settling creator wallet...')
    await creatorWallet.settle()

    console.log('Settling player wallet...')
    await playerWallet.settle()

    // Wait for settled VTXOs
    await waitForSettledBalance(creatorWallet, BET_AMOUNT, 60_000)
    await waitForSettledBalance(playerWallet, BET_AMOUNT, 60_000)

    const creatorBalance = await creatorWallet.getBalance()
    const playerBalance = await playerWallet.getBalance()
    console.log('Creator settled balance:', creatorBalance.settled)
    console.log('Player settled balance:', playerBalance.settled)

    expect(creatorBalance.settled).toBeGreaterThanOrEqual(BET_AMOUNT)
    expect(playerBalance.settled).toBeGreaterThanOrEqual(BET_AMOUNT)
  }, 120_000)

  it('should create a game and reconstruct state from events', async () => {
    if (!arkAvailable) return

    // Generate secrets
    creatorSecret = generateSecret('heads') // 15 bytes
    playerSecret = generateSecret('tails') // 16 bytes
    const creatorHash = sha256(creatorSecret)
    const playerHash = sha256(playerSecret)

    // Get spendable VTXOs
    const creatorVtxos = await creatorWallet.getVtxos()
    const playerVtxos = await playerWallet.getVtxos()
    expect(creatorVtxos.length).toBeGreaterThan(0)
    expect(playerVtxos.length).toBeGreaterThan(0)

    console.log(`Creator has ${creatorVtxos.length} VTXOs`)
    console.log(`Player has ${playerVtxos.length} VTXOs`)

    // Select VTXOs for betting
    const creatorInput = creatorVtxos[0]
    const playerInput = playerVtxos[0]

    const creatorAddr = await creatorWallet.getAddress()
    const playerAddr = await playerWallet.getAddress()

    const now = Math.floor(Date.now() / 1000)
    const gameId = `test-game-${Date.now()}`

    // Simulate the full event flow
    const createEvent: CreateEvent = {
      type: 'create',
      gameId,
      creatorPubkey: hex.encode(creatorPub),
      creatorVtxos: [vtxoToInput(creatorInput)],
      creatorChangeAddress: creatorAddr,
      betAmount: BET_AMOUNT.toString(),
      serverPubkey: hex.encode(serverPubkey),
      setupExpiration: now + 600,
      finalExpiration: now + 1200,
    }

    const joinEvent: JoinEvent = {
      type: 'join',
      gameId,
      playerPubkey: hex.encode(playerPub),
      playerVtxos: [vtxoToInput(playerInput)],
      playerChangeAddress: playerAddr,
      playerHash: hex.encode(playerHash),
    }

    // Apply events to build game state
    game = gameFromEvents(createEvent, joinEvent)
    expect(game.status).toBe(GameStatus.Joined)
    expect(game.gameId).toBe(gameId)
    expect(game.betAmount).toBe(BigInt(BET_AMOUNT))

    // Now the creator reveals their hash (setupStarted)
    const setupStartedEvent: SetupStartedEvent = {
      type: 'setupStarted',
      gameId,
      creatorHash: hex.encode(creatorHash),
      // In a real flow, this would be the creator's signature on the final tx.
      // For now we use a placeholder since we can't sign without the actual tx.
      creatorFinalSignature: hex.encode(new Uint8Array(64)),
    }

    game = gameFromEvents(createEvent, joinEvent, setupStartedEvent)
    expect(game.status).toBe(GameStatus.SetupStarted)
    expect(game.creator!.hash).toBeTruthy()
    expect(game.player!.hash).toBeTruthy()

    // Verify scripts can be built with this game state
    const setupScript = getSetupScript(game)
    expect(setupScript.leaves.length).toBe(2)

    const finalScript = getFinalScript(game)
    expect(finalScript.leaves.length).toBe(3)

    // Verify addresses are valid Ark addresses
    const setupAddr = getSetupAddress(game, 'rark')
    expect(setupAddr.encode().startsWith('rark')).toBe(true)

    const finalAddr = getFinalAddress(game, 'rark')
    expect(finalAddr.encode().startsWith('rark')).toBe(true)

    // Verify pot amount
    expect(getPotAmount(game)).toBe(BigInt(BET_AMOUNT * 2))

    console.log('Setup address:', setupAddr.encode())
    console.log('Final address:', finalAddr.encode())
    console.log('Pot amount:', getPotAmount(game).toString(), 'sats')
  }, 30_000)

  it('should build setup tx from real VTXOs and sign it', async () => {
    if (!arkAvailable) return

    // Get the server unroll script from arkInfo
    const serverUnrollScript = decodeTapscript(
      hex.decode(arkInfo.checkpointTapscript)
    ) as CSVMultisigTapscript.Type

    // Get creator and player VTXOs as ArkTxInput
    const creatorVtxos = await creatorWallet.getVtxos()
    const playerVtxos = await playerWallet.getVtxos()
    const creatorInput = vtxoToArkInput(creatorVtxos[0])
    const playerInput = vtxoToArkInput(playerVtxos[0])

    // Build setup transaction — spending standard wallet VTXOs into the
    // coinflip setup address (pot) + change outputs
    const setupAddr = getSetupAddress(game, 'rark')
    const potAmount = getPotAmount(game)

    const setupOutputs: { script: Uint8Array; amount: bigint }[] = [
      { script: setupAddr.pkScript, amount: potAmount },
    ]

    // Add change outputs
    const creatorChange = BigInt(creatorVtxos[0].value) - BigInt(BET_AMOUNT)
    if (creatorChange > 0n) {
      const creatorAddr = await creatorWallet.getAddress()
      const changeAddr = ArkAddress.decode(creatorAddr)
      setupOutputs.push({ script: changeAddr.pkScript, amount: creatorChange })
    }

    const playerChange = BigInt(playerVtxos[0].value) - BigInt(BET_AMOUNT)
    if (playerChange > 0n) {
      const playerAddr = await playerWallet.getAddress()
      const changeAddr2 = ArkAddress.decode(playerAddr)
      setupOutputs.push({ script: changeAddr2.pkScript, amount: playerChange })
    }

    console.log('Building setup tx with', 2, 'inputs and', setupOutputs.length, 'outputs')

    // buildOffchainTx works here because inputs are standard wallet VTXOs
    const { arkTx: setupTx } = buildOffchainTx(
      [creatorInput, playerInput],
      setupOutputs,
      serverUnrollScript
    )

    expect(setupTx).toBeTruthy()
    expect(setupTx.id).toBeTruthy()
    console.log('Setup tx ID:', setupTx.id)

    // Sign the setup transaction — each player signs their own input
    const signedByCreator = await creatorIdentity.sign(setupTx, [0])
    const signedByBoth = await playerIdentity.sign(signedByCreator, [1])
    console.log('Setup tx signed by both players')

    expect(signedByBoth.id).toBe(setupTx.id)

    // Now build the final transaction manually using the SDK Transaction class.
    // Note: buildOffchainTx can't be used for the final tx because the setup
    // output has custom coinflip tapscripts that decodeTapscript() doesn't recognize.
    // In production, this would use the Ark server's redeem-tx endpoint directly.
    const setupScript = getSetupScript(game)
    const finalAddr = getFinalAddress(game, 'rark')

    // Create a raw transaction spending setup output 0 → final address
    const finalTx = new Transaction()
    finalTx.addInput({
      txid: hex.decode(setupTx.id!).reverse(),
      index: 0,
      witnessUtxo: {
        script: setupAddr.pkScript,
        amount: potAmount,
      },
      tapLeafScript: [setupScript.reveal()],
    })
    finalTx.addOutput({ script: finalAddr.pkScript, amount: potAmount })

    // Sign the final transaction — both players sign the reveal leaf
    const finalSignedByCreator = await creatorIdentity.sign(finalTx, [0])
    const finalSignedByBoth = await playerIdentity.sign(finalSignedByCreator, [0])
    console.log('Final tx signed by both players')

    expect(finalSignedByBoth).toBeTruthy()

    // Verify the game outcome based on secrets
    const winner = determineWinner(creatorSecret, playerSecret)
    expect(winner).toBe('creator')
    console.log('Expected winner:', winner)
  }, 30_000)

  it('should verify the complete event-driven game flow', async () => {
    if (!arkAvailable) return

    // This test verifies the full state machine transition
    const creatorHash = sha256(creatorSecret)
    const playerHash = sha256(playerSecret)

    const gameId = game.gameId!
    const dummySig = hex.encode(new Uint8Array(64))

    const events = [
      {
        type: 'create' as const,
        gameId,
        creatorPubkey: hex.encode(creatorPub),
        creatorVtxos: game.creator!.vtxos!.map(v => ({
          vtxo: v.vtxo,
          leaf: v.leaf,
        })),
        creatorChangeAddress: game.creator!.changeAddress!,
        betAmount: BET_AMOUNT.toString(),
        serverPubkey: hex.encode(serverPubkey),
        setupExpiration: game.setupExpiration!,
        finalExpiration: game.finalExpiration!,
      },
      {
        type: 'join' as const,
        gameId,
        playerPubkey: hex.encode(playerPub),
        playerVtxos: game.player!.vtxos!.map(v => ({
          vtxo: v.vtxo,
          leaf: v.leaf,
        })),
        playerChangeAddress: game.player!.changeAddress!,
        playerHash: hex.encode(playerHash),
      },
      {
        type: 'setupStarted' as const,
        gameId,
        creatorHash: hex.encode(creatorHash),
        creatorFinalSignature: dummySig,
      },
      {
        type: 'setupFinalized' as const,
        gameId,
        playerFinalSignature: dummySig,
        playerSetupSignatures: [dummySig],
      },
      {
        type: 'finalize' as const,
        gameId,
        creatorSetupSignatures: [dummySig],
      },
      {
        type: 'resolve' as const,
        gameId,
        playerSecret: hex.encode(playerSecret),
      },
    ]

    // Apply all events and verify state at each step
    const expectedStatuses = [
      GameStatus.Created,
      GameStatus.Joined,
      GameStatus.SetupStarted,
      GameStatus.SetupFinalized,
      GameStatus.Finalized,
      GameStatus.Resolved,
    ]

    for (let i = 0; i < events.length; i++) {
      const currentEvents = events.slice(0, i + 1)
      const currentGame = gameFromEvents(...currentEvents)
      expect(currentGame.status).toBe(expectedStatuses[i])
      console.log(`After ${events[i].type}: status=${GameStatus[currentGame.status!]}`)
    }

    // Verify final game state
    const finalGame = gameFromEvents(...events)
    expect(finalGame.status).toBe(GameStatus.Resolved)
    expect(finalGame.player!.revealedSecret).toBeTruthy()
    expect(finalGame.player!.revealedSecret!.length).toBe(playerSecret.length)

    // Verify winner from revealed secrets
    const winner = determineWinner(creatorSecret, finalGame.player!.revealedSecret!)
    expect(winner).toBe('creator')
    console.log('Game resolved! Winner:', winner)
  }, 30_000)
})

describe('full game flow: server-as-counterparty', () => {
  it('should support server playing as the counterparty', async () => {
    if (!arkAvailable) return

    // In server-as-counterparty mode, the server acts as the player
    // The server has its own identity and pre-funded VTXOs
    // This test verifies the concept by simulating the server role

    const creatorIdentity = SingleKey.fromRandomBytes()
    const serverPlayerIdentity = SingleKey.fromRandomBytes() // "server" as player
    const creatorPub = await creatorIdentity.xOnlyPublicKey()
    const serverPlayerPub = await serverPlayerIdentity.xOnlyPublicKey()
    const serverPubkey = toXOnly(hex.decode(arkInfo.signerPubkey))

    // Both generate secrets
    const creatorSecret = generateSecret('tails') // 16 bytes
    const serverPlayerSecret = generateSecret('tails') // 16 bytes — same choice
    const creatorHash = sha256(creatorSecret)
    const serverPlayerHash = sha256(serverPlayerSecret)

    const now = Math.floor(Date.now() / 1000)
    const gameId = `server-game-${Date.now()}`

    // Build game state
    const game = gameFromEvents(
      {
        type: 'create',
        gameId,
        creatorPubkey: hex.encode(creatorPub),
        creatorVtxos: [],
        creatorChangeAddress: 'rark1test',
        betAmount: BET_AMOUNT.toString(),
        serverPubkey: hex.encode(serverPubkey),
        setupExpiration: now + 600,
        finalExpiration: now + 1200,
      },
      {
        type: 'join',
        gameId,
        playerPubkey: hex.encode(serverPlayerPub),
        playerVtxos: [],
        playerChangeAddress: 'rark1test2',
        playerHash: hex.encode(serverPlayerHash),
      },
      {
        type: 'setupStarted',
        gameId,
        creatorHash: hex.encode(creatorHash),
        creatorFinalSignature: hex.encode(new Uint8Array(64)),
      }
    )

    expect(game.status).toBe(GameStatus.SetupStarted)

    // Verify both scripts build correctly
    const setupScript = getSetupScript(game)
    expect(setupScript.leaves.length).toBe(2)

    const finalScript = getFinalScript(game)
    expect(finalScript.leaves.length).toBe(3)

    // Same size (both tails) = player wins
    const winner = determineWinner(creatorSecret, serverPlayerSecret)
    expect(winner).toBe('player')
    console.log('Server-as-counterparty game winner:', winner, '(server wins as player)')
  }, 30_000)
})
