/**
 * E2E tests for arkade-coinflip.
 *
 * Tests run against arkade-regtest (Docker compose stack).
 * The CI workflow starts the regtest environment before running these tests.
 */

import { hex } from '@scure/base'
import { createHash } from 'crypto'
import {
  gameFromEvents,
  GameStatus,
  determineWinner,
  generateSecret,
  CoinflipSetupScript,
  CoinflipFinalScript,
  isCreateEvent,
  isJoinEvent,
  coinSelect,
  type CreateEvent,
  type JoinEvent,
  type SetupStartedEvent,
  type GameEvent,
  type VtxoInput,
} from 'arkade-coinflip'
import {
  SingleKey,
  RestArkProvider,
  ArkInfo,
  ArkAddress,
  DefaultVtxo,
  VtxoScript,
} from '@arkade-os/sdk'

// -- Unit Tests (no regtest needed) --

describe('gameFromEvents', () => {
  const creatorPubkey = hex.encode(new Uint8Array(32).fill(1))
  const playerPubkey = hex.encode(new Uint8Array(32).fill(2))
  const serverPubkey = hex.encode(new Uint8Array(32).fill(3))

  const createEvent: CreateEvent = {
    type: 'create',
    gameId: 'test-game-1',
    creatorPubkey,
    creatorVtxos: [],
    creatorChangeAddress: 'tark1...',
    betAmount: '10000',
    serverPubkey,
    setupExpiration: 1000000,
    finalExpiration: 2000000,
  }

  it('should build a game from a create event', () => {
    const game = gameFromEvents(createEvent)
    expect(game.status).toBe(GameStatus.Created)
    expect(game.gameId).toBe('test-game-1')
    expect(game.betAmount).toBe(10000n)
    expect(hex.encode(game.creator!.pubkey!)).toBe(creatorPubkey)
    expect(hex.encode(game.serverPubkey!)).toBe(serverPubkey)
  })

  it('should apply join event', () => {
    const playerHash = hex.encode(new Uint8Array(32).fill(0xaa))
    const joinEvent: JoinEvent = {
      type: 'join',
      gameId: 'test-game-1',
      playerPubkey,
      playerVtxos: [],
      playerChangeAddress: 'tark2...',
      playerHash,
    }

    const game = gameFromEvents(createEvent, joinEvent)
    expect(game.status).toBe(GameStatus.Joined)
    expect(hex.encode(game.player!.pubkey!)).toBe(playerPubkey)
    expect(hex.encode(game.player!.hash!)).toBe(playerHash)
  })

  it('should throw on game ID mismatch', () => {
    const joinEvent: JoinEvent = {
      type: 'join',
      gameId: 'different-game',
      playerPubkey,
      playerVtxos: [],
      playerChangeAddress: 'tark2...',
      playerHash: hex.encode(new Uint8Array(32)),
    }

    expect(() => gameFromEvents(createEvent, joinEvent)).toThrow('Game ID mismatch')
  })

  it('should build full game state from all events', () => {
    const hash = hex.encode(new Uint8Array(32).fill(0xbb))
    const sig = hex.encode(new Uint8Array(64).fill(0xcc))

    const events: GameEvent[] = [
      createEvent,
      {
        type: 'join',
        gameId: 'test-game-1',
        playerPubkey,
        playerVtxos: [],
        playerChangeAddress: 'tark2...',
        playerHash: hash,
      },
      {
        type: 'setupStarted',
        gameId: 'test-game-1',
        creatorHash: hash,
        creatorFinalSignature: sig,
      },
      {
        type: 'setupFinalized',
        gameId: 'test-game-1',
        playerFinalSignature: sig,
        playerSetupSignatures: [sig],
      },
      {
        type: 'finalize',
        gameId: 'test-game-1',
        creatorSetupSignatures: [sig],
      },
      {
        type: 'resolve',
        gameId: 'test-game-1',
        playerSecret: hex.encode(new Uint8Array(15).fill(0xdd)),
      },
    ]

    const game = gameFromEvents(...events)
    expect(game.status).toBe(GameStatus.Resolved)
    expect(game.player!.revealedSecret!.length).toBe(15)
  })
})

describe('determineWinner', () => {
  it('should return player when secrets are same size (both heads)', () => {
    const secret1 = new Uint8Array(15).fill(1)
    const secret2 = new Uint8Array(15).fill(2)
    expect(determineWinner(secret1, secret2)).toBe('player')
  })

  it('should return player when secrets are same size (both tails)', () => {
    const secret1 = new Uint8Array(16).fill(1)
    const secret2 = new Uint8Array(16).fill(2)
    expect(determineWinner(secret1, secret2)).toBe('player')
  })

  it('should return creator when secrets are different sizes', () => {
    const secret1 = new Uint8Array(15).fill(1) // heads
    const secret2 = new Uint8Array(16).fill(2) // tails
    expect(determineWinner(secret1, secret2)).toBe('creator')
  })

  it('should return creator when secrets are different sizes (reversed)', () => {
    const secret1 = new Uint8Array(16).fill(1) // tails
    const secret2 = new Uint8Array(15).fill(2) // heads
    expect(determineWinner(secret1, secret2)).toBe('creator')
  })

  it('should return player when creator secret is invalid size', () => {
    const secret1 = new Uint8Array(10).fill(1) // invalid
    const secret2 = new Uint8Array(15).fill(2)
    expect(determineWinner(secret1, secret2)).toBe('player')
  })

  it('should return creator when player secret is invalid size', () => {
    const secret1 = new Uint8Array(15).fill(1)
    const secret2 = new Uint8Array(20).fill(2) // invalid
    expect(determineWinner(secret1, secret2)).toBe('creator')
  })
})

describe('generateSecret', () => {
  it('should generate 15-byte secret for heads', () => {
    const secret = generateSecret('heads')
    expect(secret.length).toBe(15)
  })

  it('should generate 16-byte secret for tails', () => {
    const secret = generateSecret('tails')
    expect(secret.length).toBe(16)
  })

  it('should generate different secrets each time', () => {
    const s1 = generateSecret('heads')
    const s2 = generateSecret('heads')
    expect(hex.encode(s1)).not.toBe(hex.encode(s2))
  })
})

describe('CoinflipSetupScript', () => {
  it('should create a valid VtxoScript with 2 leaves', () => {
    const creatorPubkey = new Uint8Array(32).fill(1)
    const playerPubkey = new Uint8Array(32).fill(2)
    const serverPubkey = new Uint8Array(32).fill(3)
    const creatorHash = new Uint8Array(32).fill(0xaa)

    const script = new CoinflipSetupScript({
      creatorPubkey,
      playerPubkey,
      serverPubkey,
      creatorHash,
      setupExpiration: 1000n,
    })

    expect(script.leaves.length).toBe(2)
    expect(script.revealScriptHex).toBeTruthy()
    expect(script.abortScriptHex).toBeTruthy()

    // Should be able to find both leaves
    const reveal = script.reveal()
    expect(reveal).toBeTruthy()
    const abort = script.abort()
    expect(abort).toBeTruthy()
  })

  it('should generate a valid ArkAddress', () => {
    const creatorPubkey = new Uint8Array(32).fill(1)
    const playerPubkey = new Uint8Array(32).fill(2)
    const serverPubkey = new Uint8Array(32).fill(3)
    const creatorHash = new Uint8Array(32).fill(0xaa)

    const script = new CoinflipSetupScript({
      creatorPubkey,
      playerPubkey,
      serverPubkey,
      creatorHash,
      setupExpiration: 1000n,
    })

    const address = script.address('tark', serverPubkey)
    expect(address.encode().startsWith('tark')).toBe(true)

    // Should round-trip
    const decoded = ArkAddress.decode(address.encode())
    expect(hex.encode(decoded.serverPubKey)).toBe(hex.encode(serverPubkey))
  })
})

describe('CoinflipFinalScript', () => {
  it('should create a valid VtxoScript with 3 leaves', () => {
    const creatorPubkey = new Uint8Array(32).fill(1)
    const playerPubkey = new Uint8Array(32).fill(2)
    const serverPubkey = new Uint8Array(32).fill(3)
    const creatorHash = new Uint8Array(32).fill(0xaa)
    const playerHash = new Uint8Array(32).fill(0xbb)

    const script = new CoinflipFinalScript({
      creatorPubkey,
      playerPubkey,
      serverPubkey,
      creatorHash,
      playerHash,
      finalExpiration: 2000n,
    })

    expect(script.leaves.length).toBe(3)
    expect(script.creatorWinScriptHex).toBeTruthy()
    expect(script.playerWinScriptHex).toBeTruthy()
    expect(script.abortScriptHex).toBeTruthy()

    const creatorWin = script.creatorWin()
    expect(creatorWin).toBeTruthy()
    const playerWin = script.playerWin()
    expect(playerWin).toBeTruthy()
    const abort = script.abort()
    expect(abort).toBeTruthy()
  })
})

describe('coinSelect', () => {
  it('should select sufficient VTXOs', () => {
    const vtxos: VtxoInput[] = [
      { vtxo: { outpoint: { txid: 'a', vout: 0 }, amount: '5000', tapscripts: [] }, leaf: '' },
      { vtxo: { outpoint: { txid: 'b', vout: 0 }, amount: '3000', tapscripts: [] }, leaf: '' },
      { vtxo: { outpoint: { txid: 'c', vout: 0 }, amount: '8000', tapscripts: [] }, leaf: '' },
    ]

    const result = coinSelect(vtxos, 10000n)
    expect(result.inputs).not.toBeNull()
    expect(result.inputs!.length).toBe(2) // 8000 + 5000 = 13000
    expect(result.changeAmount).toBe(3000n)
  })

  it('should return null when insufficient funds', () => {
    const vtxos: VtxoInput[] = [
      { vtxo: { outpoint: { txid: 'a', vout: 0 }, amount: '1000', tapscripts: [] }, leaf: '' },
    ]

    const result = coinSelect(vtxos, 10000n)
    expect(result.inputs).toBeNull()
  })
})

describe('event type guards', () => {
  it('should validate create events', () => {
    expect(isCreateEvent({ type: 'create', gameId: 'x', creatorPubkey: 'abc', creatorVtxos: [] })).toBe(true)
    expect(isCreateEvent({ type: 'join', gameId: 'x' })).toBe(false)
    expect(isCreateEvent(null)).toBe(false)
    expect(isCreateEvent({})).toBe(false)
  })

  it('should validate join events', () => {
    expect(isJoinEvent({ type: 'join', gameId: 'x' })).toBe(true)
    expect(isJoinEvent({ type: 'create', gameId: 'x' })).toBe(false)
  })
})

describe('CoinflipSetupContractHandler', () => {
  const {
    CoinflipSetupContractHandler,
    COINFLIP_SETUP_TYPE,
    registerCoinflipContracts,
  } = require('arkade-coinflip')

  const creatorPubkey = new Uint8Array(32).fill(1)
  const playerPubkey = new Uint8Array(32).fill(2)
  const serverPubkey = new Uint8Array(32).fill(3)
  const creatorHash = new Uint8Array(32).fill(0xaa)
  const setupExpiration = 1_700_000_000n // unix time threshold

  const typedParams = { creatorPubkey, playerPubkey, serverPubkey, creatorHash, setupExpiration }

  it('round-trips params through serialize/deserialize', () => {
    const serialized = CoinflipSetupContractHandler.serializeParams(typedParams)
    expect(serialized.creator).toBe(hex.encode(creatorPubkey))
    expect(serialized.setupExpiration).toBe(setupExpiration.toString())
    const back = CoinflipSetupContractHandler.deserializeParams(serialized)
    expect(hex.encode(back.creatorPubkey)).toBe(hex.encode(creatorPubkey))
    expect(back.setupExpiration).toBe(setupExpiration)
  })

  it('createScript yields a CoinflipSetupScript with reveal + abort leaves', () => {
    const params = CoinflipSetupContractHandler.serializeParams(typedParams)
    const script = CoinflipSetupContractHandler.createScript(params)
    expect(script.leaves.length).toBe(2)
    expect(script.reveal()).toBeTruthy()
    expect(script.abort()).toBeTruthy()
  })

  it('selectPath picks reveal when collaborative + creatorSecret present', () => {
    const params = CoinflipSetupContractHandler.serializeParams(typedParams)
    const script = CoinflipSetupContractHandler.createScript(params)
    const creatorSecret = hex.encode(new Uint8Array(15).fill(7))
    const contract = { type: 'coinflip-setup', params: { ...params, creatorSecret }, script: '', address: '', state: 'active' as const, createdAt: 0 }
    const ctx = { collaborative: true, currentTime: 0 }
    const sel = CoinflipSetupContractHandler.selectPath(script, contract, ctx)
    expect(sel).not.toBeNull()
    expect(hex.encode(sel!.extraWitness![0])).toBe(creatorSecret)
  })

  it('selectPath picks abort when CLTV is satisfied', () => {
    const params = CoinflipSetupContractHandler.serializeParams(typedParams)
    const script = CoinflipSetupContractHandler.createScript(params)
    const contract = { type: 'coinflip-setup', params, script: '', address: '', state: 'active' as const, createdAt: 0 }
    const futureMs = Number(setupExpiration + 1n) * 1000
    const ctx = { collaborative: false, currentTime: futureMs }
    const sel = CoinflipSetupContractHandler.selectPath(script, contract, ctx)
    expect(sel).not.toBeNull()
    expect(sel!.leaf).toBeTruthy()
  })

  it('selectPath returns null when neither path is available', () => {
    const params = CoinflipSetupContractHandler.serializeParams(typedParams)
    const script = CoinflipSetupContractHandler.createScript(params)
    const contract = { type: 'coinflip-setup', params, script: '', address: '', state: 'active' as const, createdAt: 0 }
    const ctx = { collaborative: false, currentTime: 0 }
    expect(CoinflipSetupContractHandler.selectPath(script, contract, ctx)).toBeNull()
  })

  it('registerCoinflipContracts is idempotent and uses lib registry', () => {
    // Import contractHandlers from the lib (re-exported) to guarantee the
    // same singleton instance regardless of node_modules layout.
    const { contractHandlers: libRegistry } = require('arkade-coinflip')
    registerCoinflipContracts()
    registerCoinflipContracts()
    expect(libRegistry.has(COINFLIP_SETUP_TYPE)).toBe(true)
  })
})

describe('CoinflipFinalContractHandler', () => {
  const { CoinflipFinalContractHandler } = require('arkade-coinflip')

  const creatorPubkey = new Uint8Array(32).fill(1)
  const playerPubkey = new Uint8Array(32).fill(2)
  const serverPubkey = new Uint8Array(32).fill(3)
  const creatorSecret = new Uint8Array(15).fill(7) // heads (15 bytes)
  const playerSecret = new Uint8Array(16).fill(8)  // tails (16 bytes)
  const { createHash } = require('crypto')
  const creatorHash = new Uint8Array(createHash('sha256').update(creatorSecret).digest())
  const playerHash = new Uint8Array(createHash('sha256').update(playerSecret).digest())
  const finalExpiration = 1_700_000_000n

  const typedParams = { creatorPubkey, playerPubkey, serverPubkey, creatorHash, playerHash, finalExpiration }
  const serialized = CoinflipFinalContractHandler.serializeParams(typedParams)
  const script = CoinflipFinalContractHandler.createScript(serialized)

  it('createScript yields a CoinflipFinalScript with 3 leaves', () => {
    expect(script.leaves.length).toBe(3)
    expect(script.creatorWin()).toBeTruthy()
    expect(script.playerWin()).toBeTruthy()
    expect(script.abort()).toBeTruthy()
  })

  it('selectPath picks creatorWin when secret sizes differ (heads vs tails)', () => {
    const contract = {
      type: 'coinflip-final',
      params: { ...serialized, creatorSecret: hex.encode(creatorSecret), playerSecret: hex.encode(playerSecret) },
      script: '', address: '', state: 'active' as const, createdAt: 0,
    }
    const sel = CoinflipFinalContractHandler.selectPath(script, contract, { collaborative: true, currentTime: 0 })
    expect(sel).not.toBeNull()
    expect(sel!.leaf).toEqual(script.creatorWin())
    expect(sel!.extraWitness).toHaveLength(2)
  })

  it('selectPath picks playerWin when secret sizes match', () => {
    // Both 15-byte secrets → sizes match → player wins
    const sameSize = new Uint8Array(15).fill(9)
    const sameSizeHash = new Uint8Array(createHash('sha256').update(sameSize).digest())
    const params = CoinflipFinalContractHandler.serializeParams({
      ...typedParams, creatorHash: sameSizeHash, playerHash: sameSizeHash,
    })
    const sameScript = CoinflipFinalContractHandler.createScript(params)
    const contract = {
      type: 'coinflip-final',
      params: { ...params, creatorSecret: hex.encode(sameSize), playerSecret: hex.encode(sameSize) },
      script: '', address: '', state: 'active' as const, createdAt: 0,
    }
    const sel = CoinflipFinalContractHandler.selectPath(sameScript, contract, { collaborative: true, currentTime: 0 })
    expect(sel!.leaf).toEqual(sameScript.playerWin())
  })

  it('selectPath picks abort when finalExpiration has passed', () => {
    const contract = {
      type: 'coinflip-final', params: serialized,
      script: '', address: '', state: 'active' as const, createdAt: 0,
    }
    const futureMs = Number(finalExpiration + 1n) * 1000
    const sel = CoinflipFinalContractHandler.selectPath(script, contract, { collaborative: false, currentTime: futureMs })
    expect(sel!.leaf).toEqual(script.abort())
  })
})

// -- Integration Tests (require regtest) --

/** Strip prefix byte from compressed pubkey to get x-only (32 bytes) */
function toXOnly(pubkey: Uint8Array): Uint8Array {
  return pubkey.length === 33 ? pubkey.slice(1) : pubkey
}

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'

describe('integration: ark server connection', () => {
  // Skip integration tests if ARK_SERVER_URL is not available
  let arkAvailable = false

  beforeAll(async () => {
    try {
      const resp = await fetch(`${ARK_SERVER_URL}/v1/info`, {
        signal: AbortSignal.timeout(5000),
      })
      arkAvailable = resp.ok
    } catch {
      console.log('Ark server not available, skipping integration tests')
    }
  })

  it('should connect to ark server and get info', async () => {
    if (!arkAvailable) return

    const provider = new RestArkProvider(ARK_SERVER_URL)
    const info = await provider.getInfo()

    expect(info.signerPubkey).toBeTruthy()
    expect(info.network).toBe('regtest')
    expect(info.dust).toBeGreaterThan(0n)
  })

  it('should create an identity and derive an ark address', async () => {
    if (!arkAvailable) return

    const identity = SingleKey.fromRandomBytes()
    const pubkey = await identity.xOnlyPublicKey()
    expect(pubkey.length).toBe(32)

    const provider = new RestArkProvider(ARK_SERVER_URL)
    const info = await provider.getInfo()
    const serverPubkey = toXOnly(hex.decode(info.signerPubkey))

    // Create a DefaultVtxo script and derive address
    const vtxoScript = new DefaultVtxo.Script({
      pubKey: pubkey,
      serverPubKey: serverPubkey,
    })

    const address = vtxoScript.address('rark', serverPubkey)
    expect(address.encode().startsWith('rark')).toBe(true)
  })

  it('should create a coinflip setup script with real server pubkey', async () => {
    if (!arkAvailable) return

    const provider = new RestArkProvider(ARK_SERVER_URL)
    const info = await provider.getInfo()
    const serverPubkey = toXOnly(hex.decode(info.signerPubkey))

    const creatorKey = SingleKey.fromRandomBytes()
    const playerKey = SingleKey.fromRandomBytes()
    const creatorPub = await creatorKey.xOnlyPublicKey()
    const playerPub = await playerKey.xOnlyPublicKey()

    const secret = generateSecret('heads')
    const hash = createHash('sha256').update(secret).digest()

    const setupScript = new CoinflipSetupScript({
      creatorPubkey: creatorPub,
      playerPubkey: playerPub,
      serverPubkey,
      creatorHash: new Uint8Array(hash),
      setupExpiration: BigInt(Math.floor(Date.now() / 1000) + 600),
    })

    // Verify the script is valid
    expect(setupScript.leaves.length).toBe(2)

    const address = setupScript.address('rark', serverPubkey)
    const encoded = address.encode()
    expect(encoded.startsWith('rark')).toBe(true)

    // Verify round-trip
    const decoded = ArkAddress.decode(encoded)
    expect(hex.encode(decoded.serverPubKey)).toBe(hex.encode(serverPubkey))
  })

  it('should create both setup and final scripts for a complete game', async () => {
    if (!arkAvailable) return

    const provider = new RestArkProvider(ARK_SERVER_URL)
    const info = await provider.getInfo()
    const serverPubkey = toXOnly(hex.decode(info.signerPubkey))

    const creatorKey = SingleKey.fromRandomBytes()
    const playerKey = SingleKey.fromRandomBytes()
    const creatorPub = await creatorKey.xOnlyPublicKey()
    const playerPub = await playerKey.xOnlyPublicKey()

    const creatorSecret = generateSecret('heads')
    const playerSecret = generateSecret('tails')
    const creatorHash = new Uint8Array(createHash('sha256').update(creatorSecret).digest())
    const playerHash = new Uint8Array(createHash('sha256').update(playerSecret).digest())

    const now = Math.floor(Date.now() / 1000)

    // Setup script
    const setupScript = new CoinflipSetupScript({
      creatorPubkey: creatorPub,
      playerPubkey: playerPub,
      serverPubkey,
      creatorHash,
      setupExpiration: BigInt(now + 600),
    })

    expect(setupScript.leaves.length).toBe(2)

    // Final script
    const finalScript = new CoinflipFinalScript({
      creatorPubkey: creatorPub,
      playerPubkey: playerPub,
      serverPubkey,
      creatorHash,
      playerHash,
      finalExpiration: BigInt(now + 1200),
    })

    expect(finalScript.leaves.length).toBe(3)

    // Determine winner
    const winner = determineWinner(creatorSecret, playerSecret)
    expect(winner).toBe('creator') // heads vs tails = different sizes = creator wins
  })
})
