/**
 * Unit test for the admin POST /api/games/expire-pending endpoint — the ops
 * override that releases stranded pending games (and their VTXO reservations)
 * on demand, instead of waiting for the 5-minute expiry timer. No regtest: the
 * admin router is mounted with a fake `deps` whose games repo records the call,
 * so this nails the validation + wiring deterministically.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import express from 'express'
import request from 'supertest'
const { createAdminRoutes } = require('arkade-coinflip-server/dist/admin/routes.js')

type ExpireResult = { expired: number; rows: { id: string }[] }

function mount(expirePending: () => Promise<ExpireResult>) {
  const calls: number[] = []
  const deps = {
    repos: {
      games: {
        expirePending: async (m: number) => { calls.push(m); return expirePending() },
      },
    },
  } as any
  const app = express()
  app.use(express.json())
  app.use(createAdminRoutes(deps))
  return { app, calls }
}

describe('admin POST /api/games/expire-pending', () => {
  it('expires pending games and returns the released ids', async () => {
    const { app, calls } = mount(async () => ({ expired: 2, rows: [{ id: 'g1' }, { id: 'g2' }] }))
    const res = await request(app).post('/api/games/expire-pending').send({ olderThanMinutes: 3 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ expired: 2, ids: ['g1', 'g2'] })
    expect(calls).toEqual([3]) // the requested age is passed straight through
  })

  it('defaults olderThanMinutes to 0 when omitted (clear everything now)', async () => {
    const { app, calls } = mount(async () => ({ expired: 0, rows: [] }))
    const res = await request(app).post('/api/games/expire-pending').send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ expired: 0, ids: [] })
    expect(calls).toEqual([0])
  })

  it('rejects a negative olderThanMinutes with 400 and never touches the repo', async () => {
    const { app, calls } = mount(async () => ({ expired: 0, rows: [] }))
    const res = await request(app).post('/api/games/expire-pending').send({ olderThanMinutes: -5 })
    expect(res.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('rejects a non-numeric olderThanMinutes with 400', async () => {
    const { app, calls } = mount(async () => ({ expired: 0, rows: [] }))
    const res = await request(app).post('/api/games/expire-pending').send({ olderThanMinutes: 'soon' })
    expect(res.status).toBe(400)
    expect(calls).toEqual([])
  })
})

export {}
