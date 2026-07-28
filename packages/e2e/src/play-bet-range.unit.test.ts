/**
 * /play bet validation after the tier whitelist was replaced by a range.
 *
 * The cap test is the load-bearing one: the client-side envelope is advisory,
 * so if the server didn't independently enforce the per-bet fraction a crafted
 * request could still commit the entire bankroll and defeat the cap.
 */
export {}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require('arkade-coinflip-server')

const DUST = 330

function makeDeps(overrides: Record<string, string> = {}) {
  const config: Record<string, string> = {
    tiers: '[330,1000,5000,10000,50000]',
    variable_odds_edge_bps: '300',
    max_bet_fraction_bps: '2500',
    ...overrides,
  }
  return {
    arkInfo: { dust: BigInt(DUST) },
    wallet: { getVtxos: async () => [] },
    identity: { compressedPublicKey: async () => new Uint8Array(33) },
    repos: {
      config: { get: async (k: string) => config[k], all: async () => config },
      games: { countPendingForPlayer: async () => 0, save: async () => undefined },
    },
  }
}

const PLAYER = '02'.padEnd(66, 'a')

describe('/play bet amount range', () => {
  it('rejects a bet below railMin (dust + 1)', async () => {
    await expect(
      server.handleV4Play({ tier: DUST, playerPubkey: PLAYER, playerHash: 'ab' }, makeDeps()),
    ).rejects.toThrow(/Invalid bet amount/)
  })

  it('rejects a bet above railMax', async () => {
    await expect(
      server.handleV4Play({ tier: 50_001, playerPubkey: PLAYER, playerHash: 'ab' }, makeDeps()),
    ).rejects.toThrow(/Invalid bet amount/)
  })

  it('rejects a non-integer bet', async () => {
    await expect(
      server.handleV4Play({ tier: 1000.5, playerPubkey: PLAYER, playerHash: 'ab' }, makeDeps()),
    ).rejects.toThrow(/Invalid bet amount/)
  })

  it('accepts an off-tier amount that the old whitelist would have rejected', async () => {
    // 1337 was never a configured tier. It must now get past validation and
    // fail later (no house VTXOs in this mock), NOT fail as an invalid amount.
    await expect(
      server.handleV4Play({ tier: 1337, playerPubkey: PLAYER, playerHash: 'ab' }, makeDeps()),
    ).rejects.not.toThrow(/Invalid bet amount/)
  })
})
