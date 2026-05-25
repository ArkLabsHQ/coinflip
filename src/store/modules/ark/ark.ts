import { Module } from 'vuex'
import { hex, base64 } from '@scure/base'
import type { State as RootState } from '@/store'
import {
  Wallet, SingleKey, VtxoScript,
  buildOffchainTx, decodeTapscript, CSVMultisigTapscript, ConditionWitness, setArkPsbtField, Transaction, ArkAddress,
  type WalletBalance, type ExtendedVirtualCoin, type ArkTxInput, type ArkProvider, type Identity,
} from '@arkade-os/sdk'
import { initSwaps, destroySwaps } from '@/services/boltz'
import { getNetwork, play as apiPlay, commit as apiCommit, refund as apiRefund, type Outpoint } from '@/services/api'
import { createHash } from '@/utils/crypto'

/** VtxoInput shape expected by the server's /api/play endpoint. */
export interface VtxoInput {
  vtxo: {
    outpoint: { txid: string; vout: number }
    amount: string
    tapscripts: string[]
  }
  leaf: string
}

/**
 * Convert an SDK VTXO into the lib's VtxoInput shape. Mirrors
 * `vtxoToInput` in packages/server/src/game-engine.ts — see that file for
 * the gory tap-tree / leaf-version notes.
 */
function vtxoToPlayerInput(v: ExtendedVirtualCoin): VtxoInput {
  const fullScript = VtxoScript.decode(v.tapTree)
  const tapscripts = fullScript.scripts.map((s) => hex.encode(s))
  const forfeitScript = v.forfeitTapLeafScript[1].slice(0, -1)
  return {
    vtxo: {
      outpoint: { txid: v.txid, vout: v.vout },
      amount: v.value.toString(),
      tapscripts,
    },
    leaf: hex.encode(forfeitScript),
  }
}

/**
 * Stalled-bet refunds. When the player escrows a stake we immediately fetch the
 * server-built refund tx and persist it locally — BEFORE revealing/committing.
 * If the server then stalls (or the tab closes mid-game), the player still holds
 * a self-submittable refund and can reclaim the stake after the CLTV with no
 * trust in the server. The stash is cleared once the game resolves.
 */
const REFUNDS_KEY = 'trustlessRefunds'

export interface StashedRefund {
  gameId: string
  tier: number
  playerEscrow: Outpoint
  refundPsbt: string
  refundCheckpoints: string[]
  finalExpiration: number
  createdAt: number
}

function loadRefunds(): StashedRefund[] {
  try {
    const arr = JSON.parse(localStorage.getItem(REFUNDS_KEY) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function saveRefunds(list: StashedRefund[]): void {
  localStorage.setItem(REFUNDS_KEY, JSON.stringify(list))
}

function stashRefund(r: StashedRefund): void {
  saveRefunds([...loadRefunds().filter((x) => x.gameId !== r.gameId), r])
}

function clearRefund(gameId: string): void {
  saveRefunds(loadRefunds().filter((x) => x.gameId !== gameId))
}

export interface ArkServerInfo {
  pubkey: string
  network: string
  dust: string
  unilateralExitDelay: string
  boardingExitDelay?: string
  sessionDuration?: string
}

export interface ArkVTXO {
  outpoint: {
    txid: string
    vout: number
  }
  redeemTx?: string
  amount: string
  tapscripts: string[]
  isPreconfirmed?: boolean
}

export interface BoardingUtxo {
  outpoint: { txid: string; vout: number }
  amount: string
  confirmations?: number
}

export interface TxHistoryEntry {
  /** Best txid we have — arkTxid first, then commitment, then boarding. */
  txid: string
  /** 'SENT' | 'RECEIVED' */
  type: string
  /** Net sats moved by this tx (positive for received, positive for sent — direction in `type`). */
  amount: number
  settled: boolean
  /** Unix ms */
  createdAt: number
  /** True if this entry corresponds to a boarding deposit. */
  isBoarding: boolean
}

interface ArkState {
  server: string
  esplora: string
  networkPreset: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  lastError: Error | null
  info: ArkServerInfo | null
  vtxos: ArkVTXO[]
  boardingUtxos: BoardingUtxo[]
  walletBalance: WalletBalance | null
  arkAddress: string | null
  boardingAddress: string | null
  txHistory: TxHistoryEntry[]
}

/**
 * Network presets. Only the Ark server URL is strictly required — the SDK
 * derives the network from the server's /v1/info, then auto-defaults esplora
 * (ESPLORA_URL[network]) and the Boltz API (BASE_URLS[network]) when those are
 * left empty. So mutinynet just needs the server URL; regtest pins all three
 * at localhost.
 */
export interface NetworkPreset {
  label: string
  server: string
  /** Empty string → let the SDK auto-default from the detected network. */
  esplora: string
  /** Empty string → let boltz-swap auto-default from the detected network. */
  boltz: string
}

export const NETWORK_PRESETS: Record<string, NetworkPreset> = {
  regtest: {
    label: 'Regtest (local)',
    server: 'http://localhost:7070',
    esplora: 'http://localhost:3000',
    boltz: 'http://localhost:9069',
  },
  mutinynet: {
    label: 'Mutinynet',
    server: 'https://mutinynet.arkade.sh',
    esplora: '',
    boltz: '',
  },
}

/**
 * Single-party offchain submit: sign `signInputs` on the ark tx + every
 * checkpoint with `identity`, optionally attaching a condition witness (revealed
 * secrets) to the signed inputs. arkd co-signs the server leg. Mirrors the
 * server's submitOffchain (both proven by the regtest e2e). SDK-only, so it
 * bundles for the browser (the lib's tx-builders are Node-crypto bound).
 */
async function submitOffchain(
  arkProvider: ArkProvider,
  identity: Identity,
  arkTx: Transaction,
  checkpoints: Transaction[],
  signInputs: number[],
  witness?: Uint8Array[],
): Promise<string> {
  if (witness) for (const i of signInputs) setArkPsbtField(arkTx, i, ConditionWitness, witness)
  const signed = await identity.sign(arkTx, signInputs)
  const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
    base64.encode(signed.toPSBT()),
    checkpoints.map((c) => base64.encode(c.toPSBT())),
  )
  const finals: string[] = []
  for (const c of signedCheckpointTxs) {
    const tx = Transaction.fromPSBT(base64.decode(c))
    const idx: number[] = []
    for (let i = 0; i < tx.inputsLength; i++) idx.push(i)
    if (witness) for (const i of idx) setArkPsbtField(tx, i, ConditionWitness, witness)
    finals.push(base64.encode((await identity.sign(tx, idx)).toPSBT()))
  }
  await arkProvider.finalizeTx(arkTxid, finals)
  return arkTxid
}

// SDK wallet instance (kept outside Vuex state to avoid reactivity issues with complex objects)
let sdkWallet: Wallet | null = null
// Guards the manual boarding settle so concurrent refreshBalance calls don't
// fire overlapping settlement rounds (settlementConfig is false — see Wallet.create).
let settling = false

export function getSDKWallet(): Wallet | null {
  return sdkWallet
}

const getCachedServerInfo = (): ArkServerInfo | null => {
  const cached = localStorage.getItem('ark_server_info')
  return cached ? JSON.parse(cached) : null
}

const ark: Module<ArkState, RootState> = {
  namespaced: true,

  state: {
    server: localStorage.getItem('ark_server') || 'http://localhost:7070',
    esplora: localStorage.getItem('ark_esplora') || 'http://localhost:3000',
    networkPreset: localStorage.getItem('ark_network_preset') || 'regtest',
    status: 'disconnected',
    lastError: null,
    info: getCachedServerInfo(),
    vtxos: [],
    boardingUtxos: [],
    walletBalance: null,
    arkAddress: null,
    boardingAddress: null,
    txHistory: []
  },

  mutations: {
    SET_SERVER(state, server: string) {
      state.server = server
      localStorage.setItem('ark_server', server)
    },
    SET_ESPLORA(state, esplora: string) {
      state.esplora = esplora
      if (esplora) localStorage.setItem('ark_esplora', esplora)
      else localStorage.removeItem('ark_esplora')
    },
    SET_NETWORK_PRESET(state, preset: string) {
      state.networkPreset = preset
      localStorage.setItem('ark_network_preset', preset)
    },
    SET_STATUS(state, status: ArkState['status']) {
      state.status = status
    },
    SET_ERROR(state, error: Error | null) {
      state.lastError = error
    },
    SET_INFO(state, info: ArkServerInfo | null) {
      state.info = info
      if (info) {
        localStorage.setItem('ark_server_info', JSON.stringify(info))
      } else {
        localStorage.removeItem('ark_server_info')
      }
    },
    SET_VTXOS(state, vtxos: ArkVTXO[]) {
      state.vtxos = vtxos
    },
    SET_BOARDING_UTXOS(state, utxos: BoardingUtxo[]) {
      state.boardingUtxos = utxos
    },
    SET_WALLET_BALANCE(state, balance: WalletBalance | null) {
      state.walletBalance = balance
    },
    SET_ARK_ADDRESS(state, address: string | null) {
      state.arkAddress = address
    },
    SET_BOARDING_ADDRESS(state, address: string | null) {
      state.boardingAddress = address
    },
    SET_TX_HISTORY(state, history: TxHistoryEntry[]) {
      state.txHistory = history
    }
  },

  actions: {
    updateServer({ commit }, server: string) {
      commit('SET_SERVER', server)
    },

    /**
     * Apply a named network preset (regtest / mutinynet) and reconnect.
     * Mutinynet only pins the Ark server URL; esplora + Boltz are left empty
     * so the SDK auto-defaults them from the detected network. Driven by
     * `syncNetworkFromServer`, not by the user — the network is the server's
     * choice (its ARK_SERVER_URL env), not a client toggle.
     */
    async setNetworkPreset({ commit, dispatch }, preset: string) {
      const p = NETWORK_PRESETS[preset]
      if (!p) return
      commit('SET_NETWORK_PRESET', preset)
      commit('SET_SERVER', p.server)
      commit('SET_ESPLORA', p.esplora)
      if (p.boltz) localStorage.setItem('boltz_api', p.boltz)
      else localStorage.removeItem('boltz_api')
      // Drop the cached info so the UI doesn't show the previous network.
      commit('SET_INFO', null)
      await dispatch('checkConnection')
    },

    /**
     * Ask the coinflip server which network it's on and align the client to
     * it before connecting the wallet. The server's network is fixed by its
     * env, so the client never picks independently — it follows. Falls back
     * to the current preset if the server is unreachable.
     */
    async syncNetworkFromServer({ state, dispatch }) {
      try {
        const { network } = await getNetwork()
        if (NETWORK_PRESETS[network] && network !== state.networkPreset) {
          await dispatch('setNetworkPreset', network) // applies + reconnects
          return
        }
      } catch {
        /* server unreachable — connect with whatever we have */
      }
      await dispatch('checkConnection')
    },

    async checkConnection({ commit, state, rootState, dispatch }) {
      try {
        commit('SET_STATUS', 'connecting')

        const privateKey = rootState.wallet.privateKey
        if (!privateKey) {
          throw new Error('No wallet key available')
        }

        // Create SDK wallet. esploraUrl is omitted when empty so the SDK
        // auto-defaults it from the network it detects at the Ark server.
        const identity = SingleKey.fromHex(privateKey)
        const wallet = await Wallet.create({
          identity,
          arkServerUrl: state.server,
          ...(state.esplora ? { esploraUrl: state.esplora } : {}),
          // Disable the SDK's settlement poll loop. It finalizes the game's
          // preconfirmed VTXOs (escrow change, sweep payout) into batch rounds
          // every poll, paying the per-intent fee each time — a ~5k-sats/flip
          // leak measured on regtest. We settle boarding ourselves (see
          // refreshBalance) so funding still works; preconfirmed game VTXOs
          // stay spendable off-chain without being re-settled.
          settlementConfig: false,
        })

        sdkWallet = wallet

        // Force a full VTXO re-scan when the wallet key or Ark server changes.
        // The SDK's sync cursor is GLOBAL, so a stale cursor left by a previous
        // wallet (or a different network) makes this connection skip the indexer
        // scan — a freshly restored key would then show a 0 balance. Clearing it
        // only on a context change keeps routine reconnects fast.
        const syncCtx = `${rootState.wallet.publicKey || ''}@${state.server}`
        if (syncCtx !== localStorage.getItem('ark_last_sync_ctx')) {
          await wallet.clearSyncCursor().catch((e) => console.warn('clearSyncCursor failed:', e))
          localStorage.setItem('ark_last_sync_ctx', syncCtx)
        }

        // Get server info via REST for display
        const response = await fetch(`${state.server}/v1/info`, {
          signal: AbortSignal.timeout(5000)
        })
        if (!response.ok) {
          throw new Error(`Server returned ${response.status}`)
        }
        const raw = await response.json()
        const info: ArkServerInfo = {
          pubkey: raw.pubkey || raw.signerPubkey,
          network: raw.network,
          dust: raw.dust || raw.utxoMinAmount,
          unilateralExitDelay: raw.unilateralExitDelay,
          boardingExitDelay: raw.boardingExitDelay,
          sessionDuration: raw.sessionDuration,
        }

        commit('SET_INFO', info)

        // Get addresses from SDK
        const arkAddress = await wallet.getAddress()
        const boardingAddress = await wallet.getBoardingAddress()
        commit('SET_ARK_ADDRESS', arkAddress)
        commit('SET_BOARDING_ADDRESS', boardingAddress)

        commit('SET_STATUS', 'connected')
        commit('SET_ERROR', null)

        // Initialize swap service (Lightning + chain swaps via Boltz)
        try {
          const boltzApi = localStorage.getItem('boltz_api') || (info.network === 'regtest' ? 'http://localhost:9069' : undefined)
          await initSwaps(wallet, boltzApi)
        } catch (swapErr) {
          console.warn('Swap service unavailable:', swapErr)
        }

        await dispatch('refreshBalance')

        return info
      } catch (error) {
        console.error('Failed to connect to Ark server:', error)
        await destroySwaps().catch(() => {})
        sdkWallet = null
        commit('SET_STATUS', 'error')
        commit('SET_ERROR', new Error(`Failed to connect: ${(error as Error).message}`))
        commit('SET_INFO', null)
        commit('SET_ARK_ADDRESS', null)
        commit('SET_BOARDING_ADDRESS', null)
        return null
      }
    },

    async refreshBalance({ commit, state, dispatch }) {
      if (!sdkWallet || state.status !== 'connected') return

      try {
        const balance = await sdkWallet.getBalance()
        commit('SET_WALLET_BALANCE', balance)

        // settlementConfig is false, so the SDK won't auto-settle boarding.
        // Settle it ourselves once funds land (guarded against concurrency).
        // Fire-and-forget: the round is slow; the next refresh shows the result.
        if (balance.boarding.total > 0 && !settling) {
          settling = true
          const w = sdkWallet
          w.settle()
            .then(() => dispatch('refreshBalance'))
            .catch((e) => console.warn('boarding settle failed:', e))
            .finally(() => { settling = false })
        }

        // Also fetch VTXOs for detailed display
        const vtxos = await sdkWallet.getVtxos()
        commit('SET_VTXOS', vtxos
          .filter((v: ExtendedVirtualCoin) => v.virtualStatus.state !== 'spent')
          .map((v: ExtendedVirtualCoin) => ({
            outpoint: { txid: v.txid, vout: v.vout },
            amount: String(v.value),
            tapscripts: [],
            isPreconfirmed: v.virtualStatus.state === 'preconfirmed',
          }))
        )

        // Fetch boarding UTXOs
        const boardingUtxos = await sdkWallet.getBoardingUtxos()
        commit('SET_BOARDING_UTXOS', boardingUtxos.map((u) => ({
          outpoint: { txid: u.txid, vout: u.vout },
          amount: String(u.value),
          confirmations: u.status.confirmed && u.status.block_height ? u.status.block_height : 0,
        })))

        // Fetch wallet transaction history (Ark + boarding combined).
        // SDK returns ArkTransaction[] with TxKey carrying arkTxid /
        // commitmentTxid / boardingTxid — flatten to a single best-effort
        // txid and a `isBoarding` flag for the UI.
        const history = await sdkWallet.getTransactionHistory()
        commit('SET_TX_HISTORY', history.map((tx) => ({
          txid: tx.key.arkTxid || tx.key.commitmentTxid || tx.key.boardingTxid,
          type: tx.type,
          amount: tx.amount,
          settled: tx.settled,
          createdAt: tx.createdAt,
          isBoarding: !!tx.key.boardingTxid && !tx.key.arkTxid,
        })))
      } catch (error) {
        console.error('Failed to refresh balance:', error)
      }
    },

    async sendBitcoin(_ctx, { address, amount }: { address: string; amount: number }) {
      if (!sdkWallet) throw new Error('Wallet not connected')

      const txid = await sdkWallet.sendBitcoin({ address, amount })

      // Refresh balance after send
      await _ctx.dispatch('refreshBalance')

      return txid
    },

    async settle(_ctx, params?: { eventCallback?: (event: unknown) => void }) {
      if (!sdkWallet) throw new Error('Wallet not connected')

      const txid = await sdkWallet.settle(undefined, params?.eventCallback as never)

      await _ctx.dispatch('refreshBalance')

      return txid
    },

    /**
     * Greedy-select spendable VTXOs to cover `amount` sats, returning them in
     * the VtxoInput shape the server's /api/play endpoint expects. Throws
     * if the wallet does not have enough spendable balance.
     */
    async selectPlayerVtxoInputs(_ctx, amount: number): Promise<VtxoInput[]> {
      if (!sdkWallet) throw new Error('Wallet not connected')
      const all = await sdkWallet.getVtxos()
      const spendable = all
        .filter((v: ExtendedVirtualCoin) => v.virtualStatus.state !== 'spent')
        .sort((a, b) => Number(b.value - a.value))
      const picked: ExtendedVirtualCoin[] = []
      let sum = 0n
      for (const v of spendable) {
        picked.push(v)
        sum += BigInt(v.value)
        if (sum >= BigInt(amount)) break
      }
      if (sum < BigInt(amount)) {
        throw new Error(`Insufficient balance: have ${sum}, need ${amount}`)
      }
      return picked.map(vtxoToPlayerInput)
    },

    /**
     * Play one trustless coin game end-to-end:
     *   1. POST /api/play — the house escrows its stake; returns the escrow address.
     *   2. Escrow the player's stake into that address (single-party send).
     *   3. POST /api/game/:id/commit — reveal + resolve. House win → the server
     *      already swept; player win → sign + submit the returned sweep PSBT.
     * Returns the commit result { winner, payout, houseSecret, playerSecret, proof }.
     */
    async playTrustlessGame(
      { state, rootState, dispatch },
      { tier, side, oddsN, oddsTarget, oddsLo }: { tier: number; side?: 'heads' | 'tails'; oddsN?: number; oddsTarget?: number; oddsLo?: number },
    ) {
      if (!sdkWallet) throw new Error('Wallet not connected')
      const privateKey = rootState.wallet.privateKey
      if (!privateKey) throw new Error('No wallet key available')
      const playerPubkey = rootState.wallet.publicKey
      if (!playerPubkey) throw new Error('No wallet public key available')
      const playerChangeAddress = state.arkAddress
      if (!playerChangeAddress) throw new Error('No Ark address available — wallet still connecting?')

      const identity = SingleKey.fromHex(privateKey)
      const arkProvider = sdkWallet.arkProvider
      const arkInfo = await arkProvider.getInfo()
      const serverUnroll = decodeTapscript(hex.decode(arkInfo.checkpointTapscript)) as CSVMultisigTapscript.Type

      // 1. Commit a secret + start the game. Coin: 15B heads / 16B tails.
      // Variable-odds: encode a uniform digit in [0, oddsN) as the secret LENGTH
      // (base 16 = the lib's VARIABLE_ODDS_BASE_LEN), so the summed roll is fair.
      const isVariable = oddsN !== undefined && oddsTarget !== undefined
      let secretBytes: Uint8Array
      if (isVariable) {
        const VARIABLE_ODDS_BASE_LEN = 16 // must match arkade-coinflip's constant
        secretBytes = new Uint8Array(VARIABLE_ODDS_BASE_LEN + Math.floor(Math.random() * (oddsN as number)))
      } else {
        secretBytes = new Uint8Array(side === 'tails' ? 16 : 15)
      }
      crypto.getRandomValues(secretBytes)
      const playerSecretHex = Array.from(secretBytes).map((b) => b.toString(16).padStart(2, '0')).join('')
      const playerHash = await createHash(secretBytes)

      const playRes = await apiPlay(
        tier, playerPubkey, playerHash, playerChangeAddress,
        isVariable ? { oddsN: oddsN as number, oddsTarget: oddsTarget as number, oddsLo: oddsLo ?? 0 } : undefined,
      )

      // 2. Escrow the player's stake into the shared escrow address (single-party).
      const escrowPk = ArkAddress.decode(playRes.escrowAddress).pkScript
      const pv = (await sdkWallet.getVtxos())
        .filter((v: ExtendedVirtualCoin) => v.virtualStatus.state !== 'spent')
        .sort((a, b) => Number(b.value - a.value))
        .find((v) => v.value >= tier)
      if (!pv) throw new Error(`No spendable VTXO covering ${tier} sats`)
      const change = pv.value - tier
      const outputs: { script: Uint8Array; amount: bigint }[] = [{ script: escrowPk, amount: BigInt(tier) }]
      if (change > 0) outputs.push({ script: ArkAddress.decode(playerChangeAddress).pkScript, amount: BigInt(change) })
      const escrowInput: ArkTxInput = { txid: pv.txid, vout: pv.vout, value: pv.value, tapLeafScript: pv.forfeitTapLeafScript, tapTree: pv.tapTree }
      const escrowTx = buildOffchainTx([escrowInput], outputs, serverUnroll)
      const playerEscrowTxid = await submitOffchain(arkProvider, identity, escrowTx.arkTx, escrowTx.checkpoints, [0])
      const playerEscrow: Outpoint = { txid: playerEscrowTxid, vout: 0, value: tier }

      // 2b. Stash a self-submittable refund BEFORE revealing. If the server now
      // stalls, the player can still reclaim the escrow after finalExpiration
      // without trusting it. Best-effort: a stash failure shouldn't abort a game
      // that will almost certainly resolve, but log it loudly.
      try {
        const r = await apiRefund(playRes.gameId, playerEscrow)
        stashRefund({
          gameId: playRes.gameId, tier, playerEscrow,
          refundPsbt: r.refundPsbt, refundCheckpoints: r.refundCheckpoints,
          finalExpiration: r.finalExpiration, createdAt: Date.now(),
        })
      } catch (e) {
        console.warn('[trustless] could not stash refund (continuing):', e instanceof Error ? e.message : e)
      }

      // 3. Reveal + resolve. On ANY failure the stash is kept so the player can
      // reclaim after the timelock; on success the escrow is swept, so we clear
      // it. Player win → the server built the playerWin sweep; we sign + submit.
      let result: Awaited<ReturnType<typeof apiCommit>>
      try {
        result = await apiCommit(playRes.gameId, playerSecretHex, playerEscrow)
        if (result.winner === 'player' && result.sweep) {
          const s = result.sweep
          const sweepArk = Transaction.fromPSBT(hex.decode(s.sweepPsbt))
          const sweepCps = s.sweepCheckpoints.map((c) => Transaction.fromPSBT(hex.decode(c)))
          const witness = s.witnessHex.map((w) => hex.decode(w))
          const inputs = Array.from({ length: s.inputCount }, (_, i) => i)
          await submitOffchain(arkProvider, identity, sweepArk, sweepCps, inputs, witness)
        }
      } catch (e) {
        const when = new Date(playRes.finalExpiration * 1000).toLocaleString()
        throw new Error(
          `${e instanceof Error ? e.message : 'Game failed to resolve'} — your ${tier} sat stake is safe and reclaimable after ${when} (see "Reclaim stalled bets").`,
        )
      }
      clearRefund(playRes.gameId)

      await dispatch('refreshBalance').catch(() => { /* deferred for indexer lag */ })
      return result
    },

    /** Locally-stashed stalled bets (escrows reclaimable if the server stalled). */
    listStalledBets(): StashedRefund[] {
      return loadRefunds()
    },

    /**
     * Reclaim a stalled bet by signing + submitting its stashed refund. arkd
     * enforces the CLTV, so this only succeeds at/after finalExpiration; before
     * that we surface a clear "not yet" message. Clears the stash on success.
     */
    async reclaimStalledBet({ rootState, dispatch }, gameId: string) {
      if (!sdkWallet) throw new Error('Wallet not connected')
      const privateKey = rootState.wallet.privateKey
      if (!privateKey) throw new Error('No wallet key available')
      const stash = loadRefunds().find((x) => x.gameId === gameId)
      if (!stash) throw new Error('No stashed refund for this game')
      if (Math.floor(Date.now() / 1000) < stash.finalExpiration) {
        throw new Error(`Not reclaimable yet — the timelock lifts at ${new Date(stash.finalExpiration * 1000).toLocaleString()}.`)
      }
      const identity = SingleKey.fromHex(privateKey)
      const refundArk = Transaction.fromPSBT(hex.decode(stash.refundPsbt))
      const refundCps = stash.refundCheckpoints.map((c) => Transaction.fromPSBT(hex.decode(c)))
      await submitOffchain(sdkWallet.arkProvider, identity, refundArk, refundCps, [0])
      clearRefund(gameId)
      await dispatch('refreshBalance').catch(() => { /* deferred for indexer lag */ })
    },
  },

  getters: {
    serverPubkey: (state) => state.info?.pubkey || null,
    serverNetwork: (state) => state.info?.network || null,
    dust: (state) => state.info?.dust ? parseInt(state.info.dust) : null,
    address: (state) => state.arkAddress,
    boardingAddress: (state) => state.boardingAddress,
    vtxos: (state) => state.vtxos,
    balance: (state) => {
      if (state.walletBalance) {
        return BigInt(state.walletBalance.available)
      }
      return state.vtxos.reduce((sum, vtxo) => sum + BigInt(vtxo.amount), BigInt(0))
    },
    formattedBalance: (_state, getters): string => {
      const balance = getters.balance
      if (!balance) return '0'
      return Number(balance).toLocaleString()
    },
    boardingUtxos: (state) => state.boardingUtxos,
    boardingBalance: (state) => {
      if (state.walletBalance) {
        return BigInt(state.walletBalance.boarding.total)
      }
      return state.boardingUtxos.reduce((sum, u) => sum + BigInt(u.amount), BigInt(0))
    },
    walletBalance: (state) => state.walletBalance,
    txHistory: (state) => state.txHistory,
    networkPreset: (state) => state.networkPreset,
    networkPresets: () => NETWORK_PRESETS,
  }
}

export default ark
