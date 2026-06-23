import 'fake-indexeddb/auto'
import { describe, it, expect, vi, afterAll } from 'vitest'
import { hex } from '@scure/base'
import { createHash } from 'crypto'
import { SingleKey, ArkAddress } from '@arkade-os/sdk'
import ark from './ark'
import { putV4Forfeit, loadV4Forfeits, deleteV4Forfeit } from './v4ForfeitStashStore'

// LIVE: run via `npm run test:live` with the local regtest stack up (arkd :7070
// + coinflip server :3001). EXCLUDED from the default/CI `test:unit` run (see
// vitest.config.ts) since it needs the stack; also self-skips if arkd is
// unreachable. This closes the client happy-path caveat WITHOUT a browser
// framework: it dispatches the REAL connect action (which sets the module-level
// sdkWallet that blocked a pure unit test — fetch works in jsdom), then drives the
// real claimV4Forfeit through BOTH stages with a real-built/real-signed tx and the
// emulator stubbed (echoing the arkTx), asserting the stash round-trip
// stage1 -> stageTwoOutpoint -> swept/deleted.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const A = (ark as any).actions
const PK = (seed: string) => SingleKey.fromHex(seed.repeat(32))
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
const realFetch = globalThis.fetch.bind(globalThis)

afterAll(() => { vi.restoreAllMocks() })

describe('client recovery: full staged claim under vitest (live stack only)', () => {
  it('connect -> inject stash -> claimV4Forfeit drives stage 1 then stage 2 (stash round-trip)', async (ctx) => {
    const up = await realFetch('http://localhost:7070/v1/info').then((r) => r.ok).catch(() => false)
    if (!up) { ctx.skip(); return }

    // 1. Real connect -> sdkWallet + arkAddress.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: any = { server: 'http://localhost:7070', esplora: 'http://localhost:3000/api', claimingGames: {}, arkAddress: '', status: 'disconnected' }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const commit = vi.fn((m: string, p: any) => { if (m === 'SET_SERVER') state.server = p; if (m === 'SET_ESPLORA') state.esplora = p; if (m === 'SET_ARK_ADDRESS') state.arkAddress = p })
    const dispatch = vi.fn(async () => undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rootState: any = { wallet: { privateKey: '11'.repeat(32) } }
    try { await A.checkConnection({ commit, state, rootState, dispatch }) } catch (e) { console.warn('[live] connect:', String(e).slice(0, 160)) }
    if (!state.arkAddress) { console.warn('[live] wallet did not connect (no arkAddress) — skipped'); ctx.skip(); return }

    // 2. Covenant consistent with the connected wallet (player pubkey + payout).
    const playerPk = await PK('11').xOnlyPublicKey()
    const payoutHex = hex.encode(ArkAddress.decode(state.arkAddress).pkScript)
    const playerSecret = new Uint8Array(17).fill(7) // [digit]||salt
    const now = Math.floor(Date.now() / 1000)
    const covenant = {
      creatorPubkey: hex.encode(await PK('22').xOnlyPublicKey()),
      playerPubkey: hex.encode(playerPk),
      serverPubkey: hex.encode(await PK('33').xOnlyPublicKey()),
      creatorHash: hex.encode(sha(new Uint8Array(17).fill(9))),
      playerHash: hex.encode(sha(playerSecret)),
      finalExpiration: now + 3600, cancelDelay: now + 1800, exitDelay: 86_528,
      oddsN: 2, oddsTarget: 1, oddsLo: 0,
      emulatorPubkey: hex.encode(await PK('44').xOnlyPublicKey()),
      playerPayoutPkScript: payoutHex,
      housePayoutPkScript: '5120' + 'cd'.repeat(32),
      playerStake: 1000, houseStake: 1000,
    }
    await deleteV4Forfeit('g-live')
    await putV4Forfeit({
      contractVersion: 'v4', gameId: 'g-live', tier: 1000,
      potOutpoint: { txid: 'ab'.repeat(32), vout: 0, value: 2000 },
      covenant, forfeitClaimableAt: covenant.finalExpiration,
      forfeitEmulatorUrl: 'http://localhost:7073', playerSecretHex: hex.encode(playerSecret),
      createdAt: Date.now(),
    })

    // 3. Stub ONLY the emulator (echo the submitted arkTx as the signedArkTx); the
    //    arkd provider call (getInfo) still hits the live node.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: any, opts: any) => {
      if (String(url).includes(':7073')) {
        const body = JSON.parse(opts.body as string)
        return new Response(JSON.stringify({ signedArkTx: body.arkTx }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return realFetch(url, opts)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)

    // 4. STAGE 1 — publishes the secret, pot -> StageTwo; persists stageTwoOutpoint.
    await A.claimV4Forfeit({ state, rootState, commit }, { gameId: 'g-live', mode: 'manual' })
    const afterStage1 = (await loadV4Forfeits()).find((s) => s.gameId === 'g-live')
    expect(afterStage1?.stageTwoOutpoint?.txid).toBeTruthy()
    console.log('[live] stage 1 persisted stageTwoOutpoint:', afterStage1?.stageTwoOutpoint?.txid?.slice(0, 12))

    // 5. STAGE 2 — sweeps the pot; drops the stash.
    await A.claimV4Forfeit({ state, rootState, commit }, { gameId: 'g-live', mode: 'manual' })
    expect((await loadV4Forfeits()).find((s) => s.gameId === 'g-live')).toBeUndefined()
    console.log('[live] stage 2 swept the pot + cleared the stash')
  }, 60_000)
})
