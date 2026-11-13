import 'fake-indexeddb/auto'
import { describe, it, expect, vi, afterAll } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { SingleKey, ArkAddress, configureEventSource } from '@arkade-os/sdk'
import { EventSource } from 'eventsource'
import type { ActionContext } from 'vuex'
import type { State as RootState } from '@/store'
import type { ArkState } from './arkTypes'
import ark from './ark'
import { checkConnection, claimV4Forfeit, disconnect, getSDKWallet } from './walletRuntime'
import { putV4Forfeit, loadV4Forfeits, deleteV4Forfeit } from './v4ForfeitStashStore'

const PK = (seed: string) => SingleKey.fromHex(seed.repeat(32))
const sha = sha256
const realFetch = globalThis.fetch.bind(globalThis)
const operatorUrl = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const esploraUrl = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const emulatorUrl = process.env.EMULATOR_URL || 'http://localhost:7073'
vi.hoisted(() => {
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return storage.size }, clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)) },
    removeItem: (key: string) => { storage.delete(key) },
    key: (index: number) => [...storage.keys()][index] ?? null,
  } })
})
configureEventSource(url => new EventSource(url))

afterAll(async () => { await disconnect(); vi.restoreAllMocks() })

describe('client recovery against a live operator', () => {
  it('keeps the secret and never posts a fabricated pot without its real parent transaction', async () => {
    const response = await realFetch(`${operatorUrl}/v1/info`, { signal: AbortSignal.timeout(5000) })
    expect(response.ok).toBe(true)
    expect((await response.json()).network).toBe('regtest')
    const posts = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input) === '/api/network') return Response.json({
        network: 'regtest', operatorUrl, esploraUrl, emulator: null, protocolVersion: 'v4',
      })
      if (String(input).startsWith(emulatorUrl)) {
        posts()
        throw new Error('A fabricated pot must never reach the emulator')
      }
      return realFetch(input, options)
    })
    const privateKey = '11'.repeat(32)
    const publicKey = hex.encode(await PK('11').xOnlyPublicKey())
    const state = { ...(ark.state as ArkState), claimingGames: {} }
    const context = {
      state,
      rootState: { wallet: { privateKey, publicKey, mnemonic: null, isInitialized: true } },
      commit: vi.fn((name: string, payload: unknown) => {
        if (name === 'SET_SERVER') state.server = String(payload)
        if (name === 'SET_ESPLORA') state.esplora = String(payload)
        if (name === 'SET_ARK_ADDRESS') state.arkAddress = payload as string | null
        if (name === 'SET_STATUS') state.status = payload as ArkState['status']
      }),
      dispatch: vi.fn(async () => undefined),
    } as unknown as ActionContext<ArkState, RootState>
    await checkConnection(context)
    const wallet = getSDKWallet()
    expect(wallet).not.toBeNull()
    expect(state.arkAddress).toBeTruthy()
    const playerSecret = new Uint8Array([1, ...new Uint8Array(16).fill(7)])
    const houseSecret = new Uint8Array([0, ...new Uint8Array(16).fill(9)])
    const now = Math.floor(Date.now() / 1000)
    const covenant = {
      creatorPubkey: hex.encode(await PK('22').xOnlyPublicKey()), playerPubkey: publicKey,
      serverPubkey: (await wallet!.arkProvider.getInfo()).signerPubkey.slice(-64),
      creatorHash: hex.encode(sha(houseSecret)), playerHash: hex.encode(sha(playerSecret)),
      finalExpiration: now + 1800, cancelDelay: now + 900, exitDelay: 86_528,
      oddsN: 2, oddsTarget: 1, oddsLo: 0,
      emulatorPubkey: hex.encode(await PK('44').xOnlyPublicKey()),
      playerPayoutPkScript: hex.encode(ArkAddress.decode(state.arkAddress!).pkScript),
      housePayoutPkScript: '5120' + hex.encode(await PK('22').xOnlyPublicKey()),
      playerStake: 1000, houseStake: 1000,
    }
    await putV4Forfeit({
      contractVersion: 'v4', gameId: 'g-unfunded-live', tier: 1000,
      potOutpoint: { txid: 'ab'.repeat(32), vout: 0, value: 2000 }, covenant,
      forfeitClaimableAt: covenant.finalExpiration, forfeitEmulatorUrl: emulatorUrl,
      playerSecretHex: hex.encode(playerSecret), createdAt: Date.now(),
    })
    await expect(claimV4Forfeit(context, { gameId: 'g-unfunded-live', mode: 'manual' })).rejects.toThrow('cannot resolve the previous transaction')
    expect(posts).not.toHaveBeenCalled()
    expect((await loadV4Forfeits()).find(stash => stash.gameId === 'g-unfunded-live')?.playerSecretHex).toBe(hex.encode(playerSecret))
    await deleteV4Forfeit('g-unfunded-live')
  }, 60_000)
})
