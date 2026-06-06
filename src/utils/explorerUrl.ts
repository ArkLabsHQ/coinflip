/**
 * Build an Arkade explorer URL for a given Ark virtual txid + network.
 *
 * The txids in the game-details API are Arkade virtual transaction ids
 * (escrow vtxos, sweep vtxos, etc.), NOT Bitcoin on-chain txids — so links
 * must point at an Arkade explorer, not at mempool.space / esplora.
 *
 * Priority:
 *   1. `VUE_APP_EXPLORER_TX_URL` env override — a template with `{txid}`.
 *      e.g. `https://explorer.mutinynet.arkade.sh/tx/{txid}`.
 *      Set this on the deployment that hosts a private explorer instance,
 *      or to pin a specific explorer host.
 *   2. Default per-network Arkade explorer URLs (Ark-Labs–operated). The
 *      SDK doesn't expose these yet, so we mirror the same per-network
 *      conventions the SDK uses for arkd + mempool. Override via env if
 *      the deployment's explorer lives elsewhere.
 *
 * Returns `null` when the network is unknown and no env override is set.
 * Callers fall back to "txid only" display in that case.
 */

const TEMPLATE = (process.env.VUE_APP_EXPLORER_TX_URL || '').trim()

/**
 * Arkade explorer per-network defaults. The Ark-Labs deployments follow the
 * `explorer.<network>.arkade.sh` convention (mirrors `mempool.<network>.arkade.sh`
 * and `<network>.arkade.sh` for arkd). Operators with private explorers should
 * set `VUE_APP_EXPLORER_TX_URL` to override.
 *
 * mainnet's name varies by version: the SDK uses `bitcoin`, runtime info
 * may report `mainnet` — both alias to the same URL here.
 */
const ARKADE_EXPLORER_URL: Record<string, string> = {
  bitcoin: 'https://explorer.arkade.sh',
  mainnet: 'https://explorer.arkade.sh',
  mutinynet: 'https://explorer.mutinynet.arkade.sh',
  signet: 'https://explorer.signet.arkade.sh',
  testnet: 'https://explorer.testnet.arkade.sh',
  regtest: 'http://localhost:5173',
}

export function explorerTxUrl(txid: string, network: string | null | undefined): string | null {
  if (!txid) return null
  if (TEMPLATE) return TEMPLATE.replace('{txid}', txid)
  if (!network) return null
  const root = ARKADE_EXPLORER_URL[network]
  if (!root) return null
  return `${root}/tx/${txid}`
}
