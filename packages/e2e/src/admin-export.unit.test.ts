/**
 * Admin GET /api/export unit tests (mocked deps, no regtest).
 *
 * The export exists to get game data OFF the box for offline forensics, so the
 * load-bearing property is that it can never carry a secret with it: the
 * per-game commitment secrets (house_secret_hex / player_secret_hex) must be
 * reduced to a boolean, and the house_wallet table must never be read. The
 * first test is the guard — if a future refactor spreads the raw row into the
 * response, it fails loudly.
 *
 * The rest pin the shape the forensic analysis depends on: v4 odds/stakes
 * lifted out of the state blob, and legacy/malformed rows degrading to null
 * instead of failing the whole export.
 */
export {}

import express from 'express'
import request from 'supertest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require('arkade-coinflip-server')

/** Values that must never appear anywhere in the response body. */
const HOUSE_SECRET = 'deadbeefcafebabe'.repeat(4)
const PLAYER_SECRET = 'feedfacedeadc0de'.repeat(4)

const V4_STATE = JSON.stringify({
  protocolVersion: 'v4',
  finalExpiration: 1111,
  setupExpiration: 2222,
  oddsN: 6,
  oddsTarget: 1,
  oddsLo: 1,
  exitDelay: 144,
  pot: 6000,
  houseStake: 5000,
  potAddress: 'tark1potaddress',
  houseInputs: [{ outpoint: 'a:0' }, { outpoint: 'b:1' }],
  covenant: { playerStake: 1000, houseStake: 5000 },
  cofundArkTxid: 'aa'.repeat(32),
  cofundTxid: 'bb'.repeat(32),
})

const ROWS = [
  {
    id: 'g1', tier: 1000, player_pubkey: 'pubkey1', player_choice: 'trustless-v4',
    player_hash: 'hash1', player_change_address: null,
    house_secret_hex: HOUSE_SECRET, player_secret_hex: PLAYER_SECRET,
    winner: 'player', rake_amount: 0, payout_amount: 6000, status: 'resolved',
    house_vtxos_json: V4_STATE,
    created_at: '2026-07-06 12:00:00', resolved_at: '2026-07-06 12:05:00',
  },
  {
    // legacy shape: plain outpoint array, and the player never revealed
    id: 'g2', tier: 330, player_pubkey: 'pubkey2', player_choice: 'trustless-v4',
    player_hash: 'hash2', player_change_address: null,
    house_secret_hex: HOUSE_SECRET, player_secret_hex: null,
    winner: null, rake_amount: 0, payout_amount: null, status: 'expired',
    house_vtxos_json: '["txid:0","txid:1"]',
    created_at: '2026-07-07 12:00:00', resolved_at: null,
  },
  {
    // malformed blob must not fail the export
    id: 'g3', tier: 1000, player_pubkey: 'pubkey3', player_choice: 'trustless-v4',
    player_hash: 'hash3', player_change_address: null,
    house_secret_hex: HOUSE_SECRET, player_secret_hex: null,
    winner: 'house', rake_amount: 0, payout_amount: null, status: 'resolved',
    house_vtxos_json: '{not valid json',
    created_at: '2026-07-08 12:00:00', resolved_at: '2026-07-08 12:01:00',
  },
]

function makeDeps() {
  return {
    wallet: {
      getBalance: async () => ({ available: 0, settled: 0, preconfirmed: 0, total: 0 }),
      getTransactionHistory: async () => [],
    },
    identity: { compressedPublicKey: async () => new Uint8Array(33) },
    repos: {
      games: { list: async () => ROWS, stats: async () => ({ totalGames: ROWS.length }) },
      config: { all: async () => ({ tiers: '[330,1000]', rake_value: '2' }) },
    },
  }
}

describe('admin GET /api/export', () => {
  let app: express.Express

  beforeAll(() => {
    app = express()
    app.use(express.json())
    app.use(server.createAdminRoutes(makeDeps()))
  })

  it('NEVER leaks per-game commitment secrets', async () => {
    const res = await request(app).get('/api/export?raw=1').expect(200)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(HOUSE_SECRET)
    expect(body).not.toContain(PLAYER_SECRET)
  })

  it('reduces secret presence to a boolean', async () => {
    const res = await request(app).get('/api/export').expect(200)
    const byId = Object.fromEntries(res.body.games.map((g: { id: string }) => [g.id, g]))
    expect(byId.g1.playerRevealed).toBe(true)
    expect(byId.g2.playerRevealed).toBe(false)
    expect(byId.g1.house_secret_hex).toBeUndefined()
    expect(byId.g1.player_secret_hex).toBeUndefined()
  })

  it('lifts v4 odds + stakes out of the state blob', async () => {
    const res = await request(app).get('/api/export').expect(200)
    const g1 = res.body.games.find((g: { id: string }) => g.id === 'g1')
    expect(g1.v4).toMatchObject({
      oddsN: 6, oddsTarget: 1, oddsLo: 1,
      pot: 6000, houseStake: 5000, playerStake: 1000,
      houseInputCount: 2,
      cofundTxid: 'bb'.repeat(32),
    })
  })

  it('degrades legacy and malformed state blobs to null without failing', async () => {
    const res = await request(app).get('/api/export').expect(200)
    const byId = Object.fromEntries(res.body.games.map((g: { id: string }) => [g.id, g]))
    expect(byId.g2.v4).toBeNull()
    expect(byId.g3.v4).toBeNull()
    expect(res.body.games).toHaveLength(3)
  })

  it('omits the raw state blob unless raw=1', async () => {
    const plain = await request(app).get('/api/export').expect(200)
    expect(plain.body.games[0].houseVtxosRaw).toBeUndefined()

    const raw = await request(app).get('/api/export?raw=1').expect(200)
    const g1 = raw.body.games.find((g: { id: string }) => g.id === 'g1')
    expect(typeof g1.houseVtxosRaw).toBe('string')
  })

  it('reports export metadata (count, limit, what was redacted)', async () => {
    const res = await request(app).get('/api/export').expect(200)
    expect(res.body.meta.gameCount).toBe(3)
    expect(res.body.meta.redacted).toEqual(
      expect.arrayContaining(['house_secret_hex', 'player_secret_hex', 'house_wallet']),
    )
    expect(res.body.config).toBeDefined()
    expect(res.body.wallet.balance).toBeDefined()
  })
})
