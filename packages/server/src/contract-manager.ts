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
import {
  getGames,
  getGameByContractScript,
} from './db'
import { attemptAutoClaim } from './auto-claim'
import {
  getArkInfo,
  getHouseIdentity,
  getHouseWalletInstance,
} from './house-wallet'

let manager: ContractManager | null = null

export async function initContractManager(wallet: Wallet): Promise<void> {
  manager = await wallet.getContractManager()

  manager.onContractEvent((event) => {
    handleContractEvent(event).catch((err) => {
      console.error('[ContractManager] event handler error:', err)
    })
  })

  // Restart recovery: any game that was pending at shutdown left its contracts
  // in the SQLite repo with state="active", so the watcher already resumed
  // watching them via ContractManager.initialize(). Sweep any *resolved* /
  // *expired* games whose contracts still show active — these can leak past
  // a crash that landed between updateGame() and setContractState().
  await reconcileGameContracts()

  const counts = await summarizeContracts()
  console.log(
    `[ContractManager] ready — watching ${counts.activeSetup} coinflip-setup ` +
    `and ${counts.activeFinal} coinflip-final contracts`,
  )
}

export function getContractManager(): ContractManager {
  if (!manager) throw new Error('ContractManager not initialized')
  return manager
}

/**
 * Register the setup + final contracts for a freshly-created game so the
 * watcher will fire `vtxo_received` if either trustless-fallback tx ever
 * lands on-Ark.
 */
export async function createGameContracts(args: {
  gameId: string
  setup: { params: CoinflipSetupOptions; script: string; address: string }
  final: { params: CoinflipFinalOptions; script: string; address: string }
}): Promise<void> {
  const mgr = getContractManager()
  await mgr.createContract({
    type: COINFLIP_SETUP_TYPE,
    params: CoinflipSetupContractHandler.serializeParams(args.setup.params),
    script: args.setup.script,
    address: args.setup.address,
    state: 'active',
    label: `coinflip-setup:${args.gameId}`,
  })
  await mgr.createContract({
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
 * them. Called on resolve and on expiry.
 *
 * Best-effort: a missing contract (already inactivated, or never created
 * because the game pre-dates the contract subsystem) is not fatal.
 */
export async function markGameContractsInactive(setupScript?: string | null, finalScript?: string | null): Promise<void> {
  if (!manager) return
  for (const script of [setupScript, finalScript]) {
    if (!script) continue
    try {
      await manager.setContractState(script, 'inactive')
    } catch (err) {
      // setContractState throws if the contract doesn't exist — fine.
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('not found')) {
        console.warn(`[ContractManager] setContractState(${script.substring(0, 16)}…, inactive) failed: ${msg}`)
      }
    }
  }
}

/**
 * After a crash between updateGame(status='resolved') and setContractState,
 * the SQLite contract repo can hold rows in `state="active"` whose game is
 * actually terminal. On boot, scan resolved/expired games and inactivate.
 */
async function reconcileGameContracts(): Promise<void> {
  if (!manager) return
  const terminal = [
    ...getGames({ status: 'resolved', limit: 500 }),
    ...getGames({ status: 'expired', limit: 500 }),
  ]
  for (const game of terminal) {
    await markGameContractsInactive(game.setup_script_hex, game.final_script_hex)
  }
}

async function summarizeContracts(): Promise<{ activeSetup: number; activeFinal: number }> {
  if (!manager) return { activeSetup: 0, activeFinal: 0 }
  const [setupActive, finalActive] = await Promise.all([
    manager.getContracts({ type: COINFLIP_SETUP_TYPE, state: 'active' }),
    manager.getContracts({ type: COINFLIP_FINAL_TYPE, state: 'active' }),
  ])
  return { activeSetup: setupActive.length, activeFinal: finalActive.length }
}

async function handleContractEvent(event: ContractEvent): Promise<void> {
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

  // Fallback was triggered — surface the row in DB and (best-effort) try the
  // auto-claim path. The actual on-chain spend is deferred to a follow-up
  // because it needs careful tx-graph construction; here we log enough that
  // a human operator can intervene immediately.
  if (event.type === 'vtxo_received' && type === COINFLIP_FINAL_TYPE) {
    await annotateFallback(event.contract, event.vtxos)
  }
}

async function annotateFallback(contract: Contract, vtxos: ContractVtxo[]): Promise<void> {
  if (!manager) return
  const game = getGameByContractScript(contract.script)
  if (!game) {
    console.warn(`[ContractManager] vtxo_received on unknown final contract ${contract.script.substring(0, 32)}…`)
    return
  }

  const allPaths = await manager.getAllSpendingPaths({
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
      wallet: getHouseWalletInstance(),
      identity: getHouseIdentity(),
      arkInfo: getArkInfo(),
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
