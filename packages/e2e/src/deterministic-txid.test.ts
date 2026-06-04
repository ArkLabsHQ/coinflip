/**
 * Gating spike for the trustless-coin-settlement plan.
 *
 * The 2-call flow has the client pre-sign a claim that spends (finalArkTx.id, 0)
 * BEFORE the final tx is broadcast. That only works if the final tx's id is
 * (a) known before broadcast and (b) unchanged by signing (txid excludes
 * witness). Prove both against the live regtest arkd. If this fails, the design
 * must switch to a 3-call flow (claim after the final is broadcast).
 *
 * Builds — but never broadcasts — a real game's transactions, so funded VTXOs
 * are not required; structurally-valid VtxoInputs + live ArkInfo suffice.
 */

import { hex } from '@scure/base'
import { createHash, randomBytes } from 'crypto'
import { buildGameTransactions, generateSecret, type Game, type VtxoInput } from 'arkade-coinflip'
import { SingleKey, RestArkProvider, DefaultVtxo, type ArkInfo } from '@arkade-os/sdk'

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const NETWORK_HRP = 'rark' // regtest ark

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

describe('gate: deterministic final-tx outpoint', () => {
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

  it('final.arkTx.id is known pre-broadcast and unchanged after signing', async () => {
    if (!arkAvailable) {
      console.warn('ark server unavailable — gate test skipped')
      return
    }
    const serverPubkey = toXOnly(hex.decode(info.signerPubkey))
    const houseKey = SingleKey.fromRandomBytes()
    const playerKey = SingleKey.fromRandomBytes()
    const housePub = await houseKey.xOnlyPublicKey()
    const playerPub = await playerKey.xOnlyPublicKey()
    const creatorSecret = generateSecret('heads')
    const playerSecret = generateSecret('tails')
    const now = Math.floor(Date.now() / 1000)

    const game: Game = {
      gameId: 'gate',
      betAmount: 1000n,
      serverPubkey,
      setupExpiration: now + 600,
      finalExpiration: now + 1200,
      creator: {
        pubkey: housePub,
        hash: sha(creatorSecret),
        vtxos: [fakeVtxoInput(housePub, serverPubkey, 100000)],
        changeAddress: arkAddress(housePub, serverPubkey),
      },
      player: {
        pubkey: playerPub,
        hash: sha(playerSecret),
        vtxos: [fakeVtxoInput(playerPub, serverPubkey, 100000)],
        changeAddress: arkAddress(playerPub, serverPubkey),
      },
    }

    const built = buildGameTransactions(game, info, NETWORK_HRP)
    const idBefore = built.final.arkTx.id
    expect(idBefore).toBeTruthy()

    // Signing adds witness data only; the txid must not change.
    await houseKey.sign(built.final.arkTx, [0])
    expect(built.final.arkTx.id).toBe(idBefore)
  })
})
