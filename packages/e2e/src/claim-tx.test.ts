/**
 * Task 2: buildClaimTransaction + getFinalOutpoint.
 *
 * Builds a real game's setup/final against the live regtest arkInfo (no funded
 * VTXOs needed — we build, never broadcast), then checks the winner-claim
 * splits the pot correctly: player win → pot−rake to player + rake to house;
 * house win → full pot to the house.
 */

import { hex } from '@scure/base'
import { createHash, randomBytes } from 'crypto'
import {
  buildGameTransactions,
  buildClaimTransaction,
  getFinalOutpoint,
  generateSecret,
  type Game,
  type VtxoInput,
} from 'arkade-coinflip'
import { SingleKey, RestArkProvider, DefaultVtxo, type ArkInfo } from '@arkade-os/sdk'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const NETWORK_HRP = 'rark'

const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
const toXOnly = (p: Uint8Array): Uint8Array => (p.length === 33 ? p.slice(1) : p)

function fakeVtxoInput(pubKey: Uint8Array, serverPubkey: Uint8Array, amount: number): VtxoInput {
  const script = new DefaultVtxo.Script({ pubKey, serverPubKey: serverPubkey })
  const tapscripts = script.scripts.map((s) => hex.encode(s))
  return {
    vtxo: { outpoint: { txid: hex.encode(randomBytes(32)), vout: 0 }, amount: String(amount), tapscripts },
    leaf: tapscripts[0],
  }
}

function arkAddress(pubKey: Uint8Array, serverPubkey: Uint8Array): string {
  return new DefaultVtxo.Script({ pubKey, serverPubKey: serverPubkey }).address(NETWORK_HRP, serverPubkey).encode()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function outputAmounts(tx: any): bigint[] {
  const out: bigint[] = []
  for (let i = 0; i < tx.outputsLength; i++) out.push(tx.getOutput(i).amount as bigint)
  return out
}

describe('buildClaimTransaction', () => {
  let arkAvailable = false
  let info: ArkInfo

  beforeAll(async () => {
    try {
      info = await new RestArkProvider(ARK_SERVER_URL).getInfo()
      arkAvailable = !!info?.signerPubkey
    } catch {
      arkAvailable = false
    }
  })

  async function builtGame() {
    const serverPubkey = toXOnly(hex.decode(info.signerPubkey))
    const houseKey = SingleKey.fromRandomBytes()
    const playerKey = SingleKey.fromRandomBytes()
    const housePub = await houseKey.xOnlyPublicKey()
    const playerPub = await playerKey.xOnlyPublicKey()
    const now = Math.floor(Date.now() / 1000)
    const game: Game = {
      gameId: 'claim',
      betAmount: 1000n, // pot = 2000
      serverPubkey,
      setupExpiration: now + 600,
      finalExpiration: now + 1200,
      creator: {
        pubkey: housePub, hash: sha(generateSecret('heads')),
        vtxos: [fakeVtxoInput(housePub, serverPubkey, 100000)], changeAddress: arkAddress(housePub, serverPubkey),
      },
      player: {
        pubkey: playerPub, hash: sha(generateSecret('tails')),
        vtxos: [fakeVtxoInput(playerPub, serverPubkey, 100000)], changeAddress: arkAddress(playerPub, serverPubkey),
      },
    }
    const built = buildGameTransactions(game, info, NETWORK_HRP)
    return { game, built }
  }

  it('player-win claim splits pot into payout + rake', async () => {
    if (!arkAvailable) return
    const { game, built } = await builtGame()
    const outpoint = getFinalOutpoint(built.final.arkTx)
    expect(outpoint.vout).toBe(0)
    expect(outpoint.txid).toBe(built.final.arkTx.id)

    const claim = buildClaimTransaction(game, info, NETWORK_HRP, {
      winner: 'player', finalOutpoint: outpoint,
      payoutAddress: game.player!.changeAddress!, houseAddress: game.creator!.changeAddress!, rake: 40,
    })
    const amounts = outputAmounts(claim.arkTx)
    expect(amounts).toContain(1960n) // pot 2000 − rake 40
    expect(amounts).toContain(40n)
  })

  it('house-win claim pays the full pot to the house', async () => {
    if (!arkAvailable) return
    const { game, built } = await builtGame()
    const claim = buildClaimTransaction(game, info, NETWORK_HRP, {
      winner: 'house', finalOutpoint: getFinalOutpoint(built.final.arkTx),
      payoutAddress: game.creator!.changeAddress!, houseAddress: game.creator!.changeAddress!, rake: 0,
    })
    const amounts = outputAmounts(claim.arkTx)
    expect(amounts).toContain(2000n) // full pot
  })
})
