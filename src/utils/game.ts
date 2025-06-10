import { Bytes, sha256x2 } from "@scure/btc-signer/utils"
import { buildRedeemTx, VtxoInput } from "./psbt"
import { OP, RawWitness, ScriptNum, Transaction } from "@scure/btc-signer"
import { ArkAddress } from "@/store/modules/ark/address"
import { base64, hex } from "@scure/base"
import { vtxoScript } from "./taproot"
import { TAP_LEAF_VERSION, tapLeafHash } from "@scure/btc-signer/payment"
import { ArkVTXO } from "@/store/modules/ark/ark"
import store from "@/store"
import * as bitcoin from 'bitcoinjs-lib'

export type Transactions = {
  setup: Transaction
  final: Transaction
}

export type PlayerData = Partial<{
  pubkey: Bytes
  // the hash of the player's secret
  hash: Bytes
  // the vtxos funding the player's bet
  vtxos: VtxoInput[]
  // the address to send the change to in the setup transaction
  changeAddress: string
  // the signatures of the first transaction
  setupTxSignatures: Bytes[]
  // the signature of the final transaction
  finalTxSignature: Bytes
  // the secret revealed at the end of the game
  revealedSecret: Bytes
}>

export enum GameStatus {
  Unknown = 0,
  Created = 1,
  Joined = 2,
  SetupStarted = 3,
  SetupFinalized = 4,
  Finalized = 5,
  Resolved = 6
}

export type Game = Partial<{
  status: GameStatus
  gameId: string
  serverPubkey: Bytes
  // the amount of sats each player bets
  // the winner gets 2x the betAmount
  betAmount: bigint 
  // the creator of the game
  creator: PlayerData
  // the player joining the game
  player: PlayerData
  // the expiration of the setup transaction
  setupExpiration: number
  // the expiration of the final transaction
  finalExpiration: number
}>

export type GameEvent = CreateEvent | JoinEvent | SetupStartedEvent | SetupFinalizedEvent | FinalizeEvent | ResolveEvent

// the event emitted when a game is created
export interface CreateEvent {
  type: 'create'
  gameId: string
  creatorPubkey: string
  creatorVtxos: VtxoInput[]
  creatorChangeAddress: string
  betAmount: string
  serverPubkey: string
  setupExpiration: number
  finalExpiration: number
}

// the event emitted when the player joins a game
export interface JoinEvent {
  type: 'join'
  gameId: string
  playerPubkey: string
  playerVtxos: VtxoInput[]
  playerChangeAddress: string
  playerHash: string
}

// the event emitted when the creator built the transactions
// signing the final transaction
export interface SetupStartedEvent {
  type: 'setupStarted'
  gameId: string
  creatorHash: string
  creatorFinalSignature: string
}

// the event emitted when the player signed the final transaction + the setup transaction
export interface SetupFinalizedEvent {
  type: 'setupFinalized'
  gameId: string
  playerFinalSignature: string
  playerSetupSignatures: string[]
}

// the event emitted when the creator counter-sign the setup transaction
// and has submitted the tx
export interface FinalizeEvent {
  type: 'finalize'
  gameId: string
  creatorSetupSignatures: string[]
}

// the event emitted when the player reveals the secret
export interface ResolveEvent {
  type: 'resolve'
  gameId: string
  playerSecret: string  // hex encoded secret
}

export function isCreateEvent(event: unknown): event is CreateEvent {
  return typeof event === 'object'
    && event !== null
    && 'type' in event
    && event.type === 'create'
    && 'gameId' in event
    && typeof event.gameId === 'string'
    && 'creatorPubkey' in event
    && typeof event.creatorPubkey === 'string'
    && 'creatorVtxos' in event
    && Array.isArray(event.creatorVtxos)
}

export function isJoinEvent(event: unknown): event is JoinEvent {
  return typeof event === 'object'
    && event !== null
    && 'type' in event
    && event.type === 'join'
    && 'gameId' in event
    && typeof event.gameId === 'string'
}

export function isSetupStartedEvent(event: unknown): event is SetupStartedEvent {
  return typeof event === 'object'
    && event !== null
    && 'type' in event
    && event.type === 'setupStarted'
    && 'gameId' in event
    && typeof event.gameId === 'string'
    && 'creatorHash' in event
    && typeof event.creatorHash === 'string'
    && 'creatorFinalSignature' in event
    && typeof event.creatorFinalSignature === 'string'
}

export function isSetupFinalizedEvent(event: unknown): event is SetupFinalizedEvent {
  return typeof event === 'object'
    && event !== null
    && 'type' in event
    && event.type === 'setupFinalized'
    && 'gameId' in event
    && typeof event.gameId === 'string'
    && 'playerFinalSignature' in event
    && typeof event.playerFinalSignature === 'string'
    && 'playerSetupSignatures' in event
    && Array.isArray(event.playerSetupSignatures)
}

export function isFinalizeEvent(event: unknown): event is FinalizeEvent {
  return typeof event === 'object'
    && event !== null
    && 'type' in event
    && event.type === 'finalize'
    && 'gameId' in event
    && typeof event.gameId === 'string'
    && 'creatorSetupSignatures' in event
    && Array.isArray(event.creatorSetupSignatures)
}

export function isResolveEvent(event: unknown): event is ResolveEvent {
  return typeof event === 'object'
    && event !== null
    && 'type' in event
    && event.type === 'resolve'
    && 'gameId' in event
    && typeof event.gameId === 'string'
    && 'playerSecret' in event
    && typeof event.playerSecret === 'string'
}

// returns a game object from a list of events
export function gameFromEvents(...events: GameEvent[]): Game {
  const game: Game = {}

  for (const event of events) {
    if (game.gameId && event.gameId !== game.gameId) {
      throw new Error('Game ID mismatch')
    }

    switch (event.type) {
      case 'create':
        game.status = Math.max(game.status || 0, GameStatus.Created)
        game.gameId = event.gameId
        game.creator = {
          ...game.creator || {},
          pubkey: hex.decode(event.creatorPubkey),
          vtxos: event.creatorVtxos,
          changeAddress: event.creatorChangeAddress,
        }
        game.betAmount = BigInt(event.betAmount)
        game.serverPubkey = hex.decode(
          event.serverPubkey.length == 66 ?
          event.serverPubkey.slice(2) :
          event.serverPubkey
        )
        game.setupExpiration = event.setupExpiration
        game.finalExpiration = event.finalExpiration
        break
      case 'join':
        game.status = Math.max(game.status || 0, GameStatus.Joined)
        game.gameId = event.gameId
        game.player = {
          ...game.player || {},
          pubkey: hex.decode(event.playerPubkey),
          vtxos: event.playerVtxos,
          changeAddress: event.playerChangeAddress,
          hash: hex.decode(event.playerHash),
        }
        break
      case 'setupStarted':
        game.status = Math.max(game.status || 0, GameStatus.SetupStarted)
        game.gameId = event.gameId
        game.creator = {
          ...game.creator || {},
          hash: hex.decode(event.creatorHash),
          finalTxSignature: hex.decode(event.creatorFinalSignature),
        }
        break
      case 'setupFinalized':
        game.status = Math.max(game.status || 0, GameStatus.SetupFinalized)
        game.gameId = event.gameId
        game.player = {
          ...game.player || {},
          finalTxSignature: hex.decode(event.playerFinalSignature),
          setupTxSignatures: event.playerSetupSignatures.map(hex.decode),
        }
        break
      case 'finalize':
        game.status = Math.max(game.status || 0, GameStatus.Finalized)
        game.gameId = event.gameId
        game.creator = {
          ...game.creator || {},
          setupTxSignatures: event.creatorSetupSignatures.map(hex.decode),
        }
        break
      case 'resolve':
        game.status = Math.max(game.status || 0, GameStatus.Resolved)
        game.gameId = event.gameId
        game.player = {
          ...game.player || {},
          revealedSecret: hex.decode(event.playerSecret),
        }
        break
    }
  }

  return game
}

// returns the address of the setup transaction output
// the address has 2 tapscripts, one for the reveal and one for the aborted leaf
//
// (A + B + secret A) OR (B after timeout)
//
// this forces A to reveal their secret or else B will take the funds after a timeout
export function getSetupOutputAddress(game: Game): [ArkAddress, reveal: string, aborted: string] {
  const { creator, player } = game
  assertExist(creator, 'creator')
  assertExist(player, 'player')
  assertExist(game.serverPubkey, 'serverPubkey')
  assertExist(creator.hash, 'creator.hash')
  assertExist(creator.pubkey, 'creator.pubkey')
  assertExist(player.pubkey, 'player.pubkey')
  assertExist(game.setupExpiration, 'game.setupExpiration')
  
  // reveal script is the hash of the creator's secret + (a + b + s)
  const revealLeaf = hex.encode(new Uint8Array([
    OP.SHA256,
    0x20, // length of the player's hash secret
    ...creator.hash,
    OP.EQUAL,
    OP.VERIFY,
    0x20,
    ...player.pubkey,
    OP.CHECKSIGVERIFY,
    0x20,
    ...creator.pubkey,
    OP.CHECKSIGVERIFY,
    0x20,
    ...game.serverPubkey,
    OP.CHECKSIG
  ]))


  // creator aborted leaf, is a delayed output to the creator's pubkey
  const abortedLeaf = hex.encode(new Uint8Array([
    ...encodeLocktime(game.setupExpiration),
    OP.CHECKLOCKTIMEVERIFY,
    OP.DROP,
    0x20,
    ...player.pubkey,
    OP.CHECKSIGVERIFY,
    0x20,
    ...game.serverPubkey,
    OP.CHECKSIG
  ]))


  const tapscripts = [revealLeaf, abortedLeaf]
  const payment = vtxoScript(tapscripts)
  
  const address = ArkAddress.fromP2TR('tark', payment, game.serverPubkey)

  return [address, revealLeaf, abortedLeaf]
}

// returns the address of the final transaction outputfn  
// the address has 3 tapscripts, one for the creator winning,
// one for the player winning, and one for the aborted leaf (if the creator doesn't reveal)
//
// If len(secret A) == len(secret B)
//   B + secret B
// Else if len(secret A) != len(secret B)
//   A + secret B
// Else
//   A after timeout
//
// this forces B to reveal their secret or else A will take the funds after a timeout
function getFinalOutputAddress(game: Game): [ArkAddress, creatorWin: string, playerWin: string, aborted: string] {
  const { player, creator } = game
  assertExist(player, 'player')
  assertExist(creator, 'creator')
  assertExist(creator.hash, 'creator.hash')
  assertExist(creator.pubkey, 'creator.pubkey')
  assertExist(player.pubkey, 'player.pubkey')
  assertExist(game.serverPubkey, 'game.serverPubkey')
  assertExist(player.hash, 'player.hash')
  assertExist(game.finalExpiration, 'game.finalExpiration')

  // Script that validates the sizes and hashes of two values
  // 0 = creator wins, 1 = player wins
  const conditionScript = new Uint8Array([
    OP["2DUP"],       
    OP.SHA256,       // stack: a b a h(b)
    0x20,            // push next 32 bytes
    ...player.hash,  // player's hash to compare against
    OP.EQUALVERIFY,  // stack: a b a
    OP.SHA256,       // stack: a b h(a)
    0x20,            // push next 32 bytes
    ...creator.hash, // hash to compare against
    OP.EQUALVERIFY,  // stack: a b
    OP.SIZE,         // stack: a b size(b)
    OP.DUP,          // stack: a b size(b) size(b)
    0x60,            // stack: a b size(b) size(b) 16
    OP.EQUAL,        // stack: a b size(b) isSize16
    OP.SWAP,         // stack: a b isSize16 size(b)
    0x5f,            // stack: a b isSize16 size(b) 15
    OP.EQUAL,        // stack: a b isSize16 isSize15
    OP.BOOLOR,       // stack: a b isValidSize
    OP.NOTIF,
    OP["2DROP"],     // First DROP of DROP2
    0x00,            // stack: 0 --> creator wins
    OP.ELSE,
    OP.SWAP,         // stack: b a
    OP.SIZE,         // stack: b a size(a)
    OP.DUP,          // stack: b a size(a) size(a)
    0x60,            // stack: b a size(a) size(a) 16
    OP.EQUAL,        // stack: b a size(a) isSize16
    OP.SWAP,         // stack: b a isSize16 size(a)
    0x5f,            // stack: b a isSize16 size(a) 15
    OP.EQUAL,        // stack: b a isSize16 isSize15
    OP.BOOLOR,       // stack: b a isValidSize
    OP.NOTIF,
    OP["2DROP"],        
    0x51,            // stack: 1 --> player wins
    OP.ELSE,
    OP.SIZE,         // stack: b a size(a)
    OP.SWAP,         // stack: b size(a) a
    OP.DROP,         // stack: b size(a)
    OP.SWAP,         // stack: size(a) b
    OP.SIZE,         // stack: size(a) b size(b)
    OP.SWAP,         // stack: size(a) size(b) b
    OP.DROP,         // stack: size(a) size(b)
    OP.EQUAL,        // stack: sizes_equal
    OP.ENDIF,
    OP.ENDIF
  ])

  const creatorWinLeaf = hex.encode(new Uint8Array([
    ...conditionScript,
    OP.NOT,
    OP.VERIFY,
    0x20,
    ...creator.pubkey,
    OP.CHECKSIGVERIFY,
    0x20,
    ...game.serverPubkey,
    OP.CHECKSIG
  ]))

  const playerWinLeaf = hex.encode(new Uint8Array([
    ...conditionScript,
    OP.VERIFY,
    0x20,
    ...player.pubkey,
    OP.CHECKSIGVERIFY,
    0x20,
    ...game.serverPubkey,
    OP.CHECKSIG
  ]))

  // Player aborted leaf - allows creator to claim funds after a timeout
  const abortedLeaf = hex.encode(new Uint8Array([
    ...encodeLocktime(game.finalExpiration),
    OP.CHECKLOCKTIMEVERIFY,
    OP.DROP,
    0x20,
    ...creator.pubkey,
    OP.CHECKSIGVERIFY,
    0x20,
    ...game.serverPubkey,
    OP.CHECKSIG
  ]))

  // Create tapscript with both leaves
  const tapscripts = [creatorWinLeaf, playerWinLeaf, abortedLeaf]
  const payment = vtxoScript(tapscripts)
  
  // Create and return the address
  const address = ArkAddress.fromP2TR('tark', payment, game.serverPubkey)
  return [address, creatorWinLeaf, playerWinLeaf, abortedLeaf]
}

export function getPotAmount(game: Game): bigint {
  assertExist(game.betAmount, 'game.betAmount')
  return 2n * game.betAmount
}

export function getTransactions(game: Game): Transactions {
  const { creator, player } = game
  assertExist(creator, 'creator')
  assertExist(player, 'player')
  assertExist(creator.vtxos, 'creator.vtxos')
  assertExist(player.vtxos, 'player.vtxos')
  assertExist(creator.changeAddress, 'creator.changeAddress')
  assertExist(player.changeAddress, 'player.changeAddress')
  assertExist(game.betAmount, 'game.betAmount')

  const [setupOutputAddress, revealLeaf, abortedLeaf] = getSetupOutputAddress(game)

  const setupAmount = 2n * game.betAmount
  const outputs = [
    { value: setupAmount, address: setupOutputAddress.encode() },
  ]

  // verify creator has enough funds to cover the bet
  const sumOfCreatorInputs = creator.vtxos.reduce((acc, vtxo) => acc + BigInt(vtxo.vtxo.amount), 0n)
  const changeCreator = sumOfCreatorInputs - game.betAmount

  if (changeCreator < 0n) {
    throw new Error('Creator does not have enough funds to cover the bet')
  }

  if (changeCreator > 0n) {
    outputs.push({ value: changeCreator, address: creator.changeAddress })
  }

  // verify player has enough funds to cover the bet
  const sumOfPlayerInputs = player.vtxos.reduce((acc, vtxo) => acc + BigInt(vtxo.vtxo.amount), 0n)
  const changePlayer = sumOfPlayerInputs - game.betAmount

  if (changePlayer < 0n) {
    throw new Error('Player does not have enough funds to cover the bet')
  }

  if (changePlayer > 0n) {
    outputs.push({ value: changePlayer, address: player.changeAddress })
  }

  const setup = buildRedeemTx(
    [...creator.vtxos, ...player.vtxos],
    outputs
  )


  if (creator.setupTxSignatures && creator.setupTxSignatures.length > 0) {
    assertExist(creator.pubkey, 'creator.pubkey')

    for (let i = 0; i < creator.setupTxSignatures.length; i++) {
      const vtxo = creator.vtxos[i]

      setup.updateInput(i, {
        tapScriptSig: [
          [
            {
              pubKey: creator.pubkey,
              leafHash: tapLeafHash(hex.decode(vtxo.leaf), TAP_LEAF_VERSION)
            },
            creator.setupTxSignatures[i]
          ]
        ]
      })
    }
  }

  if (player.setupTxSignatures && player.setupTxSignatures.length > 0) {
    assertExist(player.pubkey, 'player.pubkey')

    for (let i = creator.vtxos.length; i < creator.vtxos.length + player.vtxos.length; i++) {
      const vtxo = player.vtxos[i - creator.vtxos.length]

      setup.updateInput(i, {
        tapScriptSig: [
          [
            {
              pubKey: player.pubkey,
              leafHash: tapLeafHash(hex.decode(vtxo.leaf), TAP_LEAF_VERSION)
            },
            player.setupTxSignatures[i - creator.vtxos.length]
          ]
        ]
      })
    }
  }

  const revealLeafScript = hex.decode(revealLeaf)

  const setupTxID = hex.encode(sha256x2(setup.toBytes(true)).reverse());

  const finalInput: VtxoInput = {
    vtxo: {
      amount: setupAmount.toString(),
      outpoint: {
        txid: setupTxID,
        vout: 0
      },
      tapscripts: [revealLeaf, abortedLeaf]
    },
    leaf: hex.encode(revealLeafScript)
  }

  const [finalOutputAddress] = getFinalOutputAddress(game)

  const final = buildRedeemTx(
    [finalInput],
    [{ value: setupAmount, address: finalOutputAddress.encode() }]
  )
  
  const revealLeafHash = tapLeafHash(revealLeafScript, TAP_LEAF_VERSION)
  const finalTapscriptSigs: [{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array][] = []
  if (creator.finalTxSignature) {
    assertExist(creator.pubkey, 'creator.pubkey')
    finalTapscriptSigs.push([{ pubKey: creator.pubkey, leafHash: revealLeafHash }, creator.finalTxSignature])
  }

  if (player.finalTxSignature) {
    assertExist(player.pubkey, 'player.pubkey')
    finalTapscriptSigs.push([{ pubKey: player.pubkey, leafHash: revealLeafHash }, player.finalTxSignature])
  }

  if (finalTapscriptSigs.length > 0) {
    final.updateInput(0, {
      tapScriptSig: finalTapscriptSigs
    })
  }

  return { setup, final }
}

// throws if the value is undefined or null
function assertExist(value: unknown, name: string): asserts value is NonNullable<typeof value> {
  if (value === undefined || value === null) {
    throw new Error(`Missing ${name}`)
  }
}

// Game-related constants and types
export const KIND_GAME_CREATE = 31337 // Custom event kind for game creation

// Helper function to encode script number for CLTV
function encodeLocktime(locktime: number): Uint8Array {
  // First encode the length of the locktime (4 bytes)
  const lenBytes = ScriptNum(4).encode(BigInt(4))
  
  // Then encode the actual locktime as uint32
  const locktimeBytes = new Uint8Array(4)
  new DataView(locktimeBytes.buffer).setUint32(0, locktime, false) // big-endian
  
  // Combine both
  const result = new Uint8Array(lenBytes.length + locktimeBytes.length)
  result.set(lenBytes)
  result.set(locktimeBytes, lenBytes.length)
  
  return result
}

// Constants for PSBT unknown key prefixes
export const CONDITION_WITNESS_KEY_PREFIX = new TextEncoder().encode("condition")

/**
 * Gets the condition witness from a base64 encoded PSBT
 * Returns undefined if no condition witness is found
 */
export function getConditionArgsFromTx(psbtB64: string, idx: number): Uint8Array[] | undefined {
  // Decode base64 PSBT
  const psbtBuffer = base64.decode(psbtB64)
  const psbt = bitcoin.Psbt.fromBuffer(psbtBuffer)

  // Get unknown fields from input
  const unknowns = psbt.data.inputs[idx].unknownKeyVals || []
  
  // Find the unknown with our prefix
  const conditionWitness = unknowns.find(
    ({ key }) => hex.encode(key) === hex.encode(CONDITION_WITNESS_KEY_PREFIX)
  )

  if (!conditionWitness) {
    return undefined
  }

  return RawWitness.decode(conditionWitness.value)
}

/**
 * Gets the creator's secret from the final transaction
 */
async function getCreatorSecret(game: Game, arkServerURL: string): Promise<Uint8Array> {
  const [finalAddress] = getFinalOutputAddress(game)

  const response = await fetch(`${arkServerURL}/v1/vtxos/${finalAddress.encode()}`)
  const data = await response.json()
  const vtxos = data['spendableVtxos'] as ArkVTXO[]
  if (vtxos.length === 0) {
    throw new Error('No vtxos found for final address')
  }

  const finalSubmittedTx = vtxos[0].redeemTx
  if (!finalSubmittedTx) {
    throw new Error('No redeemTx found for final address')
  }

  const secret = getConditionArgsFromTx(finalSubmittedTx, 0)
  if (!secret) {
    throw new Error('No secret found in transaction')
  }

  if (secret.length !== 1) {
    throw new Error('Invalid secret length')
  }

  return secret[0]
}

// cashout transaction spends the final transaction and sends the funds to the creator
export async function cashoutTx(
  game: Game,
  arkServerURL: string,
  playerSecret: Uint8Array,
  signerPrivateKey: Uint8Array,
  signerPubkey: Uint8Array
): Promise<boolean> {
  assertExist(game.creator, 'game.creator')
  
  const { final } = getTransactions(game)
  const [,creatorWinLeaf, playerWinLeaf, abortedLeaf] = getFinalOutputAddress(game)
  
  let secret: Uint8Array | null = null  
  try {
    secret = await getCreatorSecret(game, arkServerURL)
  } catch (error) {
    if (error instanceof Error && error.message === 'No vtxos found for final address') {
      return false
    }
    throw error
  }

  console.log('creatorSecret', hex.encode(secret), secret.length)
  console.log('playerSecret', hex.encode(playerSecret), playerSecret.length)
  let winLeaf = null
  let cashoutAddress = null
  if ((secret.length != 15 && secret.length != 16) || secret.length === playerSecret.length) {
    assertExist(game.player, 'game.player')
    assertExist(game.player.pubkey, 'game.player.pubkey')
    assertExist(game.player.changeAddress, 'game.player.changeAddress')
    if (hex.encode(signerPubkey) !== hex.encode(game.player.pubkey)) {
      return false
    }
    winLeaf = playerWinLeaf
    cashoutAddress = game.player.changeAddress
  } else {
    assertExist(game.creator, 'game.creator')
    assertExist(game.creator.pubkey, 'game.creator.pubkey')
    assertExist(game.creator.changeAddress, 'game.creator.changeAddress')
    if (hex.encode(signerPubkey) !== hex.encode(game.creator.pubkey)) {
      return false
    }
    winLeaf = creatorWinLeaf
    cashoutAddress = game.creator.changeAddress
  }

  const finalTxID = hex.encode(sha256x2(final.toBytes(true)).reverse());

  const cashout = buildRedeemTx(
    [{
      vtxo: {
        amount: getPotAmount(game).toString(),
        outpoint: {
          txid: finalTxID,
          vout: 0
        },
        tapscripts: [creatorWinLeaf, playerWinLeaf, abortedLeaf]
      },
      leaf: winLeaf
    }],
    [{ value: getPotAmount(game), address: cashoutAddress }]
  )

  // sign the cashout tx
  cashout.sign(signerPrivateKey)

  // broadcast the cashout tx
  const psbt = cashout.toPSBT()
  let b64 = base64.encode(psbt)
  b64 = addConditionWitnessToTx(b64, 0, [secret, playerSecret])
  await store.dispatch('ark/broadcastRedeemTx', { redeemTx: b64 })

  return true
}

/**
 * Adds a condition witness to a base64 encoded PSBT
 * Returns the modified PSBT as base64
 */
export function addConditionWitnessToTx(psbtB64: string, idx: number, witness: Uint8Array[]): string {
  // Decode base64 PSBT
  const psbtBuffer = base64.decode(psbtB64)
  const psbt = bitcoin.Psbt.fromBuffer(psbtBuffer)

  // Add unknown field to input
  psbt.data.inputs[idx].unknownKeyVals = psbt.data.inputs[idx].unknownKeyVals || []
  psbt.data.inputs[idx].unknownKeyVals.push({
    key: CONDITION_WITNESS_KEY_PREFIX,
    value: RawWitness.encode(witness)
  })

  // Convert back to base64
  return base64.encode(psbt.toBuffer())
}
