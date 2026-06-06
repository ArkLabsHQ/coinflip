/**
 * Build a mempool/esplora explorer URL for a given txid + network.
 *
 * Priority:
 *   1. `VUE_APP_EXPLORER_TX_URL` env override — a template with `{txid}`.
 *      e.g. `https://mempool.mutinynet.arkade.sh/tx/{txid}`.
 *      Useful for private deployments or pinning a specific mempool host.
 *   2. SDK's `ESPLORA_URL[network]` (the esplora REST base), with `/api`
 *      stripped to yield the web UI root, then `/tx/<txid>` appended.
 *      The SDK already maps mainnet/testnet/signet/mutinynet/regtest to
 *      Ark-Labs–operated mempool deployments.
 *
 * Returns `null` when the network is unknown or no URL can be derived.
 * Callers should fall back to "txid only" display in that case.
 */
import { ESPLORA_URL } from '@arkade-os/sdk'

const TEMPLATE = (process.env.VUE_APP_EXPLORER_TX_URL || '').trim()

export function explorerTxUrl(txid: string, network: string | null | undefined): string | null {
  if (!txid) return null
  if (TEMPLATE) return TEMPLATE.replace('{txid}', txid)
  if (!network) return null
  const esplora = (ESPLORA_URL as Record<string, string | undefined>)[network]
  if (!esplora) return null
  // The Ark-Labs mempool deployments serve the web UI at the host root and
  // the REST API at `/api`. Strip the trailing `/api` to get the UI root,
  // then append the standard `/tx/<txid>` path.
  const root = esplora.replace(/\/api\/?$/, '')
  return `${root}/tx/${txid}`
}
