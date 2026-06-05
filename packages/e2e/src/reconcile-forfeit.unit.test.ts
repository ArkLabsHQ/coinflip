/**
 * Deterministic unit test for reconcilePendingSweeps' winner attribution (no
 * regtest). A game stuck `pending` with a spent house escrow was resolved by one
 * of two atomic sweeps that BOTH spend the house escrow:
 *   - the crashed HOUSE-WIN covenant sweep (pot → house), or
 *   - the player's R1 FORFEIT (pot → player).
 * The only signal is the payout output of the spending arkTx. This pins that the
 * reconciler decodes that tx and labels the winner accordingly (it used to always
 * assume `house`, mislabelling a player forfeit). The indexer is injected.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
const { hex, base64 } = require('@scure/base')
const { Transaction } = require('@arkade-os/sdk')
const { reconcilePendingSweeps } = require('arkade-coinflip-server/dist/trustless-game.js')
const { reservations } = require('arkade-coinflip-server/dist/vtxo-pool.js')

const HOUSE_TXID = 'aa'.repeat(32)
const SWEEP_TXID = 'bb'.repeat(32)
// Payout scripts: any valid scriptPubKey hex works — reconcile only hex-compares
// them. p2wpkh keeps btc-signer's PSBT round-trip happy (a bogus p2tr key is
// rejected by the OutScript parser); the real scripts are p2tr but the type is
// irrelevant to the attribution logic under test.
const PLAYER_SCRIPT = '0014' + '11'.repeat(20)
const HOUSE_SCRIPT = '0014' + '22'.repeat(20)

/** A minimal base64 PSBT carrying a single output with `scriptHex`. */
function psbtPayingTo(scriptHex: string): string {
  const tx = new Transaction({ allowUnknownOutputs: true })
  tx.addOutput({ script: hex.decode(scriptHex), amount: 6000n })
  return base64.encode(tx.toPSBT())
}

function gameRow() {
  return {
    id: 'g-pending',
    tier: 1000,
    status: 'pending',
    player_choice: 'trustless',
    house_vtxos_json: JSON.stringify({
      finalExpiration: 1,
      setupExpiration: 1,
      houseEscrow: { txid: HOUSE_TXID, vout: 0, value: 5000 },
      arkadeForfeit: {
        playerPayoutPkScriptHex: PLAYER_SCRIPT,
        housePayoutPkScriptHex: HOUSE_SCRIPT,
      },
    }),
  }
}

/** deps with a captured games.update + a fake indexer whose sweep tx pays `payoutScript`. */
function makeDepsAndIndexer(payoutScript: string) {
  const updates: any[] = []
  // reconcileGame re-fetches the game inside the per-game lock (it may have
  // resolved between list() and lock acquisition), so the fake repo must answer
  // get() as well — it returns the same pending row list() surfaced.
  const row = gameRow()
  const deps = {
    repos: {
      games: {
        list: async () => [row],
        get: async (id: string) => (id === row.id ? row : undefined),
        update: async (id: string, patch: any) => { updates.push({ id, patch }) },
      },
    },
  } as any
  const indexer = {
    getVtxos: async () => ({
      vtxos: [{ txid: HOUSE_TXID, vout: 0, value: 5000, isSpent: true, arkTxId: SWEEP_TXID, spentBy: 'cp' }],
    }),
    getVirtualTxs: async (txids: string[]) =>
      txids[0] === SWEEP_TXID ? { txs: [psbtPayingTo(payoutScript)] } : { txs: [] },
  } as any
  return { deps, indexer, updates }
}

describe('reconcilePendingSweeps winner attribution', () => {
  afterEach(() => reservations.release('g-pending'))

  it('labels a player forfeit (sweep pays the player) as winner=player', async () => {
    const { deps, indexer, updates } = makeDepsAndIndexer(PLAYER_SCRIPT)
    const n = await reconcilePendingSweeps(deps, indexer)
    expect(n).toBe(1)
    expect(updates).toHaveLength(1)
    expect(updates[0].patch.winner).toBe('player')
    expect(updates[0].patch.payoutAmount).toBe(6000) // houseEscrow.value(5000) + tier(1000)
    expect(updates[0].patch.status).toBe('resolved')
  })

  it('labels a crashed house-win sweep (sweep pays the house) as winner=house', async () => {
    const { deps, indexer, updates } = makeDepsAndIndexer(HOUSE_SCRIPT)
    const n = await reconcilePendingSweeps(deps, indexer)
    expect(n).toBe(1)
    expect(updates[0].patch.winner).toBe('house')
    expect(updates[0].patch.payoutAmount).toBe(6000)
  })

  it('falls back to house when the sweep tx cannot be decoded (safe default)', async () => {
    const { deps, updates } = makeDepsAndIndexer(PLAYER_SCRIPT)
    // Indexer that reports the escrow spent but returns no sweep tx → undecidable.
    const indexer = {
      getVtxos: async () => ({ vtxos: [{ txid: HOUSE_TXID, vout: 0, value: 5000, isSpent: true, arkTxId: SWEEP_TXID }] }),
      getVirtualTxs: async () => ({ txs: [] }),
    } as any
    const n = await reconcilePendingSweeps(deps, indexer)
    expect(n).toBe(1)
    expect(updates[0].patch.winner).toBe('house') // never mislabels a real house win
  })

  it('leaves a genuinely-unspent escrow pending (no resolution)', async () => {
    const { deps, updates } = makeDepsAndIndexer(PLAYER_SCRIPT)
    const indexer = {
      getVtxos: async () => ({ vtxos: [{ txid: HOUSE_TXID, vout: 0, value: 5000, isSpent: false }] }),
      getVirtualTxs: async () => ({ txs: [] }),
    } as any
    const n = await reconcilePendingSweeps(deps, indexer)
    expect(n).toBe(0)
    expect(updates).toHaveLength(0)
  })
})

export {}
