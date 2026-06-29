/**
 * Unit tests for the restore routes (GET /api/games/challenge, GET /api/games)
 * mounted on the real public router with a fake `deps`. No regtest.
 *
 * These pin the security-relevant wiring end-to-end through Express:
 *   - challenge issues a nonce; a 400 guards a bad pubkey;
 *   - /api/games refuses (401) without a valid challenge signature;
 *   - the happy path (real key signs the real nonce) returns the player's
 *     summaries + v4 reclaim hints;
 *   - secrets are NOT in the summary, playerSecretHex is ALWAYS null, and a v3
 *     game gets a summary but NO reclaim hint.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import express from 'express'
import request from 'supertest'
const { createPublicRoutes } = require('arkade-coinflip-server/dist/public-routes.js')
const { schnorr } = require('@noble/curves/secp256k1.js')
const { createHash } = require('crypto')

function keypair(seed: number): { sk: Uint8Array; xonly: string } {
  const sk = new Uint8Array(32).fill(seed)
  return { sk, xonly: Buffer.from(schnorr.getPublicKey(sk)).toString('hex') }
}
function sign(sk: Uint8Array, nonce: string): string {
  const msg = createHash('sha256').update(Buffer.from(nonce, 'utf8')).digest()
  return Buffer.from(schnorr.sign(msg, sk)).toString('hex')
}

/** Mount the public router with a games repo that serves `rows` to listForPlayer
 *  (filtered by pubkey + status to mirror the real repo). */
function mount(rows: any[]) {
  const calls: any[] = []
  const deps = {
    arkInfo: { network: 'regtest' },
    repos: {
      games: {
        listForPlayer: async (pk: string, opts: any = {}) => {
          calls.push({ pk, opts })
          return rows
            .filter((r) => r.player_pubkey === pk && (!opts.status || r.status === opts.status))
        },
      },
    },
  } as any
  const app = express()
  app.use(express.json())
  app.use(createPublicRoutes(deps))
  return { app, calls }
}

const V4_PENDING = (pk: string) => ({
  id: 'v4p', tier: 1000, player_pubkey: pk, player_choice: 'trustless-v4',
  player_hash: 'hh', house_secret_hex: 'HOUSE_SECRET', player_secret_hex: null,
  winner: null, rake_amount: 0, payout_amount: null, status: 'pending',
  created_at: '2026-01-02T00:00:00Z', resolved_at: null,
  house_vtxos_json: JSON.stringify({
    protocolVersion: 'v4', pot: 2000, cofundTxid: 'COFUND_TXID',
    covenant: { finalExpiration: 1893456000, playerStake: 1000, houseStake: 1000 },
  }),
})

const V3_RESOLVED = (pk: string) => ({
  id: 'v3r', tier: 1000, player_pubkey: pk, player_choice: 'trustless',
  player_hash: 'hh', house_secret_hex: 'HOUSE_SECRET', player_secret_hex: 'PLAYER_SECRET',
  winner: 'player', rake_amount: 20, payout_amount: 1980, status: 'resolved',
  created_at: '2026-01-01T00:00:00Z', resolved_at: '2026-01-01T01:00:00Z',
  house_vtxos_json: JSON.stringify({ contractVersion: 'v3', finalExpiration: 1893456000 }),
})

describe('GET /api/games/challenge', () => {
  it('issues a nonce for a valid pubkey', async () => {
    const { xonly } = keypair(0x10)
    const { app } = mount([])
    const res = await request(app).get('/api/games/challenge').query({ playerPubkey: xonly })
    expect(res.status).toBe(200)
    expect(res.body.nonce).toMatch(/^\d+\.[0-9a-f]{64}$/)
  })

  it('400s on a missing or malformed pubkey', async () => {
    const { app } = mount([])
    expect((await request(app).get('/api/games/challenge')).status).toBe(400)
    expect((await request(app).get('/api/games/challenge').query({ playerPubkey: 'nothex' })).status).toBe(400)
  })
})

describe('GET /api/games', () => {
  it('401s without a valid challenge signature', async () => {
    const { xonly } = keypair(0x20)
    const { app, calls } = mount([])
    // A well-formed but unsigned/garbage challenge must be rejected BEFORE any DB read.
    const res = await request(app).get('/api/games').query({
      playerPubkey: xonly, nonce: `${Date.now()}.${'a'.repeat(64)}`, sig: 'b'.repeat(128),
    })
    expect(res.status).toBe(401)
    expect(calls).toEqual([]) // listForPlayer never called
  })

  it('400s on a missing/invalid pubkey before auth', async () => {
    const { app } = mount([])
    expect((await request(app).get('/api/games').query({ nonce: 'x', sig: 'y' })).status).toBe(400)
  })

  it('returns summaries + a v4 reclaim hint on a valid signed request; v3 is history-only', async () => {
    const { sk, xonly } = keypair(0x21)
    const { app } = mount([V4_PENDING(xonly), V3_RESOLVED(xonly)])

    const ch = await request(app).get('/api/games/challenge').query({ playerPubkey: xonly })
    const nonce = ch.body.nonce
    const sig = sign(sk, nonce)
    const res = await request(app).get('/api/games').query({ playerPubkey: xonly, nonce, sig })

    expect(res.status).toBe(200)
    // Two summaries, both protocol-versioned.
    const byId = Object.fromEntries(res.body.games.map((g: any) => [g.gameId, g]))
    expect(Object.keys(byId).sort()).toEqual(['v3r', 'v4p'])
    expect(byId.v4p.protocolVersion).toBe('v4')
    expect(byId.v3r.protocolVersion).toBe('v3')
    expect(byId.v3r.winner).toBe('player')
    expect(byId.v3r.payoutAmount).toBe(1980)

    // Summaries NEVER carry preimages.
    const blob = JSON.stringify(res.body.games)
    expect(blob).not.toContain('HOUSE_SECRET')
    expect(blob).not.toContain('PLAYER_SECRET')

    // Exactly one reclaim hint, for the PENDING v4 game; v3 gets none.
    expect(res.body.reclaimHints).toHaveLength(1)
    const hint = res.body.reclaimHints[0]
    expect(hint.gameId).toBe('v4p')
    expect(hint.contractVersion).toBe('v4')
    expect(hint.potOutpoint).toEqual({ txid: 'COFUND_TXID', vout: 0, value: 2000 })
    expect(hint.forfeitClaimableAt).toBe(1893456000)
    expect(hint.playerSecretHex).toBeNull() // trustless: never the take-the-pot key
  })

  it('does not emit a reclaim hint for a v4 game that is no longer pending', async () => {
    const { sk, xonly } = keypair(0x22)
    const resolvedV4 = { ...V4_PENDING(xonly), id: 'v4done', status: 'resolved' }
    const { app } = mount([resolvedV4])
    const ch = await request(app).get('/api/games/challenge').query({ playerPubkey: xonly })
    const sig = sign(sk, ch.body.nonce)
    const res = await request(app).get('/api/games').query({ playerPubkey: xonly, nonce: ch.body.nonce, sig })
    expect(res.status).toBe(200)
    expect(res.body.games).toHaveLength(1)
    expect(res.body.reclaimHints).toEqual([])
  })

  it('passes the status filter through to listForPlayer', async () => {
    const { sk, xonly } = keypair(0x23)
    const { app, calls } = mount([V4_PENDING(xonly)])
    const ch = await request(app).get('/api/games/challenge').query({ playerPubkey: xonly })
    const sig = sign(sk, ch.body.nonce)
    await request(app).get('/api/games').query({ playerPubkey: xonly, nonce: ch.body.nonce, sig, status: 'pending', limit: '25' })
    expect(calls.at(-1).opts.status).toBe('pending')
    expect(calls.at(-1).opts.limit).toBe(25)
  })
})

export {}
