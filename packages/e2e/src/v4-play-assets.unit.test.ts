import { DefaultVtxo, SingleKey } from '@arkade-os/sdk'
import { hex } from '@scure/base'

const pool = require('arkade-coinflip-server/dist/vtxo-pool.js')
const emulator = require('arkade-coinflip-server/dist/emulator.js')
const { handleV4Play } = require('arkade-coinflip-server/dist/v4/play.js')

describe('normal game house asset isolation', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    for (const reservation of pool.reservations.snapshot()) pool.reservations.release(reservation.gameId)
    pool.houseVtxoCache.invalidate()
    pool.spentOutpoints.clear()
  })

  async function fixture() {
    const identity = SingleKey.fromHex('01'.repeat(32))
    const player = SingleKey.fromHex('02'.repeat(32))
    const operator = SingleKey.fromHex('03'.repeat(32))
    const emu = SingleKey.fromHex('04'.repeat(32))
    const serverPubKey = await operator.xOnlyPublicKey()
    const script = new DefaultVtxo.Script({ pubKey: await identity.xOnlyPublicKey(), serverPubKey,
      csvTimelock: { type: 'seconds', value: 512n } })
    const playerScript = new DefaultVtxo.Script({ pubKey: await player.xOnlyPublicKey(), serverPubKey,
      csvTimelock: { type: 'seconds', value: 512n } })
    const address = script.address('tark', serverPubKey).encode()
    const playerAddress = playerScript.address('tark', serverPubKey).encode()
    const coin = (txid: string, value: number) => ({ txid, vout: 0, value,
      createdAt: new Date(), isSpent: false, isSwept: false, isUnrolled: false, isPreconfirmed: true,
      spentBy: '', commitmentTxIds: [], script: hex.encode(script.pkScript),
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
      tapTree: script.encode(), forfeitTapLeafScript: script.forfeit(), assets: [],
    })
    const plain = coin('11'.repeat(32), 40_000)
    const token = { ...coin('22'.repeat(32), 500_000), assets: [{ assetId: '33'.repeat(32) + '0100', amount: 1000n }] }
    const deps = {
      identity,
      arkInfo: { signerPubkey: hex.encode(serverPubKey), network: 'regtest', dust: 330n, unilateralExitDelay: 512n },
      wallet: { getAddress: jest.fn(async () => address) },
      repos: {
        config: { get: jest.fn(async (name: string) => name === 'tiers' ? '[330,1000,5000,10000,50000]' : name === 'max_bet_fraction_bps' ? '10000' : null) },
        games: { countPendingForPlayer: jest.fn(async () => 0), save: jest.fn(async () => {}) },
      },
    }
    jest.spyOn(emulator, 'loadEmulatorConfig').mockResolvedValue({ url: 'http://unused.invalid',
      publicUrl: 'http://unused.invalid', signerPubkey: await emu.xOnlyPublicKey(), version: 'test' })
    const request = { tier: 1000, playerPubkey: hex.encode(await player.xOnlyPublicKey()), playerHash: '44'.repeat(32),
      playerPayoutAddress: playerAddress, playerChangeAddress: playerAddress }
    return { deps, request, plain, token }
  }

  it('reserves only the plain coin even when a signable share carrier is larger', async () => {
    const { deps, request, plain, token } = await fixture()
    jest.spyOn(pool.houseVtxoCache, 'get').mockResolvedValue([token, plain])
    const game = await handleV4Play(request, deps)
    expect(game.houseInputs.map((input: { txid: string }) => input.txid)).toEqual([plain.txid])
    expect(pool.reservations.isReserved(`${token.txid}:0`)).toBe(false)
    expect(deps.repos.games.save).toHaveBeenCalledTimes(1)
  })

  it('refuses admission when all house Bitcoin value is carried by shares', async () => {
    const { deps, request, token } = await fixture()
    jest.spyOn(pool.houseVtxoCache, 'get').mockResolvedValue([token])
    await expect(handleV4Play(request, deps)).rejects.toMatchObject({ name: 'BetExceedsCapacityError' })
    expect(deps.repos.games.save).not.toHaveBeenCalled()
    expect(pool.reservations.snapshot()).toEqual([])
  })
})
