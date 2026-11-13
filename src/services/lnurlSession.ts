import { arkadeLnurl } from '@arkade-os/lnurl-client/arkade'
import type { Wallet } from '@arkade-os/sdk'

const ENV_OVERRIDE = (process.env.VUE_APP_LNURL_SERVER_URL || '').trim()

/** Per-network defaults — mirrors the Arkade `<service>.<network>.arkade.sh`
 *  convention used for mempool, explorer, and arkd hosts. Mainnet drops the
 *  network prefix (`lnurl.arkade.sh`). */
const LNURL_SERVER_URL: Record<string, string> = {
  bitcoin: 'https://lnurl.arkade.sh',
  mainnet: 'https://lnurl.arkade.sh',
  mutinynet: 'https://lnurl.mutinynet.arkade.sh',
  signet: 'https://lnurl.signet.arkade.sh',
  testnet: 'https://lnurl.testnet.arkade.sh',
  regtest: 'http://localhost:9090',
}

/** Returns the server URL for the given network, honouring the
 *  `VUE_APP_LNURL_SERVER_URL` env override. `null` when neither is set. */
export function lnurlServerForNetwork(network: string | null | undefined): string | null {
  if (ENV_OVERRIDE) return ENV_OVERRIDE
  if (!network) return null
  return LNURL_SERVER_URL[network] ?? null
}

export interface LnurlSessionConfig {
  serverUrl: string
  wallet: Wallet
  signal?: AbortSignal
}
export interface LnurlSession { lnurl: string; close(): void }

/** Register the wallet's identity and destinations through the maintained client. */
export async function openLnurlSession(cfg: LnurlSessionConfig): Promise<LnurlSession> {
  const controller = new AbortController()
  const signal = cfg.signal ? AbortSignal.any([cfg.signal, controller.signal]) : controller.signal
  const receiver = arkadeLnurl({ wallet: cfg.wallet, baseUrl: cfg.serverUrl })
  const owned = await receiver.owned({ signal, refresh: true })
  const address = owned ?? await receiver.claim({}, { signal })
  signal.throwIfAborted()
  return { lnurl: address.lnurl, close: () => controller.abort() }
}
