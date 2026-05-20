/**
 * Server-side ContractManager wiring.
 *
 * Each coinflip game produces two SDK Contracts (`coinflip-setup` and
 * `coinflip-final`) that are registered with the wallet's persistent
 * SQLite-backed `ContractRepository` when the game starts and flipped to
 * `state: "inactive"` when the game resolves or expires.
 *
 * The watcher emits `vtxo_received` if a player ever broadcasts the
 * trustless-fallback setup or final tx — those events are logged and,
 * for the final contract, the auto-claim path attempts to recover the
 * pot via the handler's `selectPath`.
 */

import { hex } from '@scure/base'
import type {
  Contract,
  ContractEvent,
  ContractManager,
  ContractVtxo,
  Wallet,
} from '@arkade-os/sdk'
import {
  CoinflipFinalContractHandler,
  CoinflipSetupContractHandler,
  COINFLIP_FINAL_TYPE,
  COINFLIP_SETUP_TYPE,
  type CoinflipFinalOptions,
  type CoinflipSetupOptions,
} from 'arkade-coinflip'

import { attemptAutoClaim } from './auto-claim'
import type { AppDeps } from './deps'

/**
 * Build the ContractManager from the live Wallet, hook up the event
 * subscriber, and reconcile any orphaned active contracts left behind by
 * a crash during a previous resolve/expire.
 *
 * Returns the live ContractManager so the boot sequence can attach it to
 * AppDeps and pass it through to consumers.
 */
export async function initContractManager(
  wallet: Wallet,
  deps: Pick<AppDeps, 'repos'>,
): Promise<ContractManager> {
  const manager = await wallet.getContractManager()

  // Reconcile any games that resolved/expired since last boot but didn't
  // get their contracts flipped to "inactive" — usually a crash between
  // the games-table update and the setContractState call.
  await reconcileGameContracts(manager, deps)

  // Subscriber needs access to the full AppDeps to drive auto-claim;
  // index.ts wires it up *after* it has built AppDeps so we can read
  // the final `deps` reference here.
  return manager
}

/**
 * Attach the event subscriber once the full AppDeps is available.
 * Split from initContractManager so the AppDeps cycle (which needs
 * contractManager to be populated first) stays well-typed.
 */
export function attachContractEventHandler(deps: AppDeps): void {
  deps.contractManager.onContractEvent((event) => {
    handleContractEvent(event, deps).catch((err) => {
      console.error('[ContractManager] event handler error:', err)
    })
  })

  summarizeContracts(deps).then((counts) => {
    console.log(
      `[ContractManager] ready — watching ${counts.activeSetup} coinflip-setup ` +
      `and ${counts.activeFinal} coinflip-final contracts`,
    )
  })
}

/**
 * Register the setup + final contracts for a freshly-created game so the
 * watcher will fire `vtxo_received` if either trustless-fallback tx ever
 * lands on-Ark.
 */
export async function createGameContracts(
  deps: AppDeps,
  args: {
    gameId: string
    setup: { params: CoinflipSetupOptions; script: string; address: string }
    final: { params: CoinflipFinalOptions; script: string; address: string }
  },
): Promise<void> {
  await deps.contractManager.createContract({
    type: COINFLIP_SETUP_TYPE,
    params: CoinflipSetupContractHandler.serializeParams(args.setup.params),
    script: args.setup.script,
    address: args.setup.address,
    state: 'active',
    label: `coinflip-setup:${args.gameId}`,
  })
  await deps.contractManager.createContract({
    type: COINFLIP_FINAL_TYPE,
    params: CoinflipFinalContractHandler.serializeParams(args.final.params),
    script: args.final.script,
    address: args.final.address,
    state: 'active',
    label: `coinflip-final:${args.gameId}`,
  })
}

/**
 * Flip both contracts for a game to `inactive` so the watcher stops polling
 * them. Best-effort: a missing contract (already inactivated, or never
 * created because the game pre-dates the contract subsystem) is not fatal.
 */
export async function markGameContractsInactive(
  deps: Pick<AppDeps, 'contractManager'>,
  setupScript?: string | null,
  finalScript?: string | null,
): Promise<void> {
  for (const script of [setupScript, finalScript]) {
    if (!script) continue
    try {
      await deps.contractManager.setContractState(script, 'inactive')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('not found')) {
        console.warn(`[ContractManager] setContractState(${script.substring(0, 16)}…, inactive) failed: ${msg}`)
      }
    }
  }
}

async function reconcileGameContracts(
  manager: ContractManager,
  deps: Pick<AppDeps, 'repos'>,
): Promise<void> {
  const terminal = [
    ...(await deps.repos.games.list({ status: 'resolved', limit: 500 })),
    ...(await deps.repos.games.list({ status: 'expired', limit: 500 })),
  ]
  for (const game of terminal) {
    await markGameContractsInactive({ contractManager: manager }, game.setup_script_hex, game.final_script_hex)
  }
}

async function summarizeContracts(deps: AppDeps): Promise<{ activeSetup: number; activeFinal: number }> {
  const [setupActive, finalActive] = await Promise.all([
    deps.contractManager.getContracts({ type: COINFLIP_SETUP_TYPE, state: 'active' }),
    deps.contractManager.getContracts({ type: COINFLIP_FINAL_TYPE, state: 'active' }),
  ])
  return { activeSetup: setupActive.length, activeFinal: finalActive.length }
}

async function handleContractEvent(event: ContractEvent, deps: AppDeps): Promise<void> {
  if (event.type === 'connection_reset') {
    console.warn('[ContractManager] watcher connection reset')
    return
  }
  const type = event.contract?.type
  if (type !== COINFLIP_SETUP_TYPE && type !== COINFLIP_FINAL_TYPE) return

  const totalSats = event.vtxos.reduce((acc, v) => acc + v.value, 0)
  console.log(
    `[ContractManager] ${event.type} on ${type} ${event.contract.label ?? ''} ` +
    `(${event.vtxos.length} vtxo${event.vtxos.length === 1 ? '' : 's'}, ${totalSats} sats)`,
  )

  if (event.type === 'vtxo_received' && type === COINFLIP_FINAL_TYPE) {
    await annotateFallback(event.contract, event.vtxos, deps)
  }
}

async function annotateFallback(
  contract: Contract,
  vtxos: ContractVtxo[],
  deps: AppDeps,
): Promise<void> {
  const game = await deps.repos.games.findByContractScript(contract.script)
  if (!game) {
    console.warn(`[ContractManager] vtxo_received on unknown final contract ${contract.script.substring(0, 32)}…`)
    return
  }

  const allPaths = await deps.contractManager.getAllSpendingPaths({
    contractScript: contract.script,
    collaborative: true,
  })
  const pathSummary = allPaths.length
    ? allPaths.map((p) => `leaf=${hex.encode(p.leaf[1]).substring(0, 16)}…`).join(', ')
    : 'no spending paths'

  console.warn(
    `[ContractManager] !! trustless fallback triggered for game ${game.id} ` +
    `(status=${game.status}, winner=${game.winner ?? 'unresolved'}). ` +
    `${vtxos.length} vtxo(s) at coinflip-final, total ${vtxos.reduce((a, v) => a + v.value, 0)} sats. ` +
    `Spending paths registered for this contract: ${pathSummary}.`,
  )

  try {
    const result = await attemptAutoClaim(contract, vtxos, game, {
      wallet: deps.wallet,
      identity: deps.identity,
      arkInfo: deps.arkInfo,
    })
    if (result.attempted) {
      console.log(
        `[ContractManager] auto-claim succeeded for game ${game.id} via ${result.path}, ` +
        `arkTxid=${result.arkTxid}`,
      )
    } else {
      console.warn(`[ContractManager] auto-claim skipped for game ${game.id}: ${result.reason}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[ContractManager] auto-claim failed for game ${game.id}: ${msg}`)
  }
}
