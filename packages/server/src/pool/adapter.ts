import { arkade, ArkAddress, Estimator, isVtxoSpent, RestEmulatorProvider, Transaction, resolveEmulatorPubkey, toOffchainInputFeeParams, toXOnly, type NormalizedExtendedVirtualCoin } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { randomUUID } from 'node:crypto'
import type { PoolBootstrapRequest, PoolGameDescriptor, PoolGameSnapshot, PoolPreparedGame, PoolSubmitRequest,
  PoolOperationReceipt, PoolOperatorActionRequest, PoolOperatorCoin } from 'arkade-coinflip'
import * as vault from 'arkade-coinflip/dist/pool-game-vault.js'
import * as inputRenewal from 'arkade-coinflip/dist/pool-input-renewal.js'
import { isPoolRenewalAbandoned } from 'arkade-coinflip/dist/pool-renewal-session.js'
import type { PoolInputRenewalJournal, PoolInputRenewalPersistence, PoolInputRenewalPlan, PoolInputRenewalReceipt } from 'arkade-coinflip/dist/pool-input-renewal.js'
import type { PoolBootstrapJournal, PoolBootstrapPersistence, PoolBootstrapStage, PoolFreshAuthorization, PoolRenewalJournal, PoolRenewalPersistence, PoolRenewalReceipt } from 'arkade-coinflip/dist/pool-game-vault.js'
import type { AppDeps } from '../deps.js'
import { loadEmulatorConfig } from '../emulator.js'
import { withArkSubmit } from '../v4/concurrency.js'
import { reservations, outpointKey } from '../vtxo-pool.js'
import type { PoolRelay } from './repository.js'

export interface PoolResolution extends PoolRelay {
  expectedHead: { txid: string; vout: number }
  request: PoolSubmitRequest
}
export interface PoolInputReservation {
  readonly outpoints: readonly { txid: string; vout: number }[]
  release(): void
}
export interface PoolOperatorStage {
  version: 1
  funding: PoolBootstrapStage
  authorization: PoolFreshAuthorization
  refund?: PoolRelay
  refundHistory?: PoolRelay[]
  refunded?: boolean
}
export interface PoolAdapter {
  available(): Promise<boolean>
  restoreBootstrapHolds(journal: PoolBootstrapJournal): void
  restoreRenewalHolds(journal: PoolRenewalJournal): void
  reserveRenewalSponsor(): Promise<{ sponsor?: NormalizedExtendedVirtualCoin; reservation: PoolInputReservation }>
  renew(descriptor: PoolGameDescriptor, persistence: PoolRenewalPersistence, sponsor?: NormalizedExtendedVirtualCoin, signal?: AbortSignal, reservation?: PoolInputReservation): Promise<PoolRenewalReceipt>
  prepareInputRenewal(descriptor: PoolGameDescriptor, claimed: readonly { txid: string; vout: number }[]): Promise<{ plan: PoolInputRenewalPlan; reservation: PoolInputReservation } | undefined>
  restoreInputRenewalHolds(journal: PoolInputRenewalJournal): void
  renewInputs(persistence: PoolInputRenewalPersistence, plan?: PoolInputRenewalPlan, signal?: AbortSignal, reservation?: PoolInputReservation): Promise<PoolInputRenewalReceipt>
  restoreOperationHolds(request: PoolSubmitRequest): PoolInputReservation
  operatorCoins(descriptor: PoolGameDescriptor, snapshot: PoolGameSnapshot): Promise<PoolOperatorCoin[]>
  operatorAction(descriptor: PoolGameDescriptor, request: PoolOperatorActionRequest): Promise<{ request: PoolSubmitRequest; relay: PoolRelay; reservation: PoolInputReservation; stage?: PoolOperatorStage }>
  restoreOperatorStageHolds(stage: PoolOperatorStage): PoolInputReservation
  submitOperatorStage(descriptor: PoolGameDescriptor, stage: PoolOperatorStage, save: (next: PoolOperatorStage) => Promise<void>, refundOnly?: boolean): Promise<'funded' | 'refunded' | 'unsubmitted'>
  read(descriptor: PoolGameDescriptor): Promise<PoolGameSnapshot | undefined>
  bootstrap(request: PoolBootstrapRequest, persistence: PoolBootstrapPersistence): Promise<{ descriptor: PoolGameDescriptor; snapshot: PoolGameSnapshot }>
  authorize(descriptor: PoolGameDescriptor, request: PoolSubmitRequest, game?: PoolPreparedGame): Promise<PoolRelay>
  verify(descriptor: PoolGameDescriptor, request: PoolSubmitRequest): Promise<{ status: 'pending' | 'confirmed' | 'conflict'; receipt?: PoolOperationReceipt }>
  resolution(descriptor: PoolGameDescriptor, game: PoolPreparedGame, houseSecret: string, playerSecret: string | undefined, mode: 'settle' | 'refund'): Promise<PoolResolution>
  post(relay: PoolRelay): Promise<void>
}

export function makePoolAdapter(deps: AppDeps): PoolAdapter {
  function holdInputs(points: readonly { txid: string; vout: number }[]): PoolInputReservation {
    const id = `pool-maint:${randomUUID()}`
    reservations.bindWallet(deps.wallet)
    reservations.reserve(id, points.map(point => outpointKey(point.txid, point.vout)), 0)
    return { outpoints: points.map(point => ({ txid: point.txid, vout: point.vout })), release: () => reservations.release(id) }
  }
  function trackRestored(proofId: string, points: readonly { txid: string; vout: number }[]) {
    reservations.trackExternal(`pool-maint:restored:${proofId}`, points.map(point => outpointKey(point.txid, point.vout)))
  }
  // The SDK store can keep a coin spent by an earlier batch; the indexer decides what is still spendable.
  async function indexedUnspent<T extends NormalizedExtendedVirtualCoin>(coins: T[]): Promise<T[]> {
    if (!coins.length) return coins
    const live = (await deps.wallet.indexerProvider.getVtxos({ outpoints: coins.map(({ txid, vout }) => ({ txid, vout })), spendableOnly: false })).vtxos
    return coins.flatMap(coin => {
      const fresh = live.find(value => value.txid === coin.txid && value.vout === coin.vout)
      return fresh && !isVtxoSpent(fresh) && !fresh.isUnrolled ? [{ ...coin, isSwept: fresh.isSwept, isSpent: fresh.isSpent }] : []
    })
  }
  async function releaseRestored(persistence: { load(): Promise<{ proof: string } | undefined> }) {
    const journal = await persistence.load()
    if (journal) reservations.release(`pool-maint:restored:${Transaction.fromPSBT(base64.decode(journal.proof)).id}`)
  }
  async function loadRenewalProof(id: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid pool renewal proof ID')
    const url = new URL('/v1/intent', process.env.ARK_SERVER_URL || 'http://localhost:7070')
    url.searchParams.set('txid', id)
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) })
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_000_000) throw new Error('Pool renewal proof is unavailable or too large')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Pool renewal proof response has no body')
    const decoder = new TextDecoder()
    let size = 0, text = ''
    try {
      while (size <= 1_000_000) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > 1_000_000) throw new Error('Pool renewal proof exceeds its size limit')
        text += decoder.decode(part.value, { stream: true })
      }
      text += decoder.decode()
    } finally { await reader.cancel().catch(() => {}) }
    const proof = JSON.parse(text)?.intent?.proof
    if (typeof proof !== 'string' || proof.length > 750_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(proof)) throw new Error('Invalid pool renewal proof response')
    return proof
  }
  async function pinnedEmulator() {
    const config = await loadEmulatorConfig()
    const pinned = toXOnly(hex.decode(resolveEmulatorPubkey(deps.wallet.network)))
    const configured = process.env.POOL_EMULATOR_PUBKEY?.trim()
    if (!config || !Buffer.from(config.signerPubkey).equals(Buffer.from(pinned)) ||
        configured && !Buffer.from(toXOnly(hex.decode(configured))).equals(Buffer.from(pinned))) {
      throw new Error('Pool emulator signer does not match the supported SDK trust anchor')
    }
    return config
  }
  return {
    available: async () => { try { await pinnedEmulator(); return true } catch { return false } },
    restoreBootstrapHolds: journal => vault.restorePoolBootstrapHolds(deps.wallet, journal),
    restoreRenewalHolds: journal => {
      vault.restorePoolRenewalHolds(deps.wallet, journal)
      const proof = Transaction.fromPSBT(base64.decode(journal.proof))
      trackRestored(proof.id, Array.from({ length: proof.inputsLength - 1 }, (_, index) => {
        const input = proof.getInput(index + 1)
        return { txid: hex.encode(input.txid!), vout: input.index! }
      }))
    },
    reserveRenewalSponsor: async () => {
      const coins = await indexedUnspent(await deps.wallet.getSpendableVtxos({ requireSynced: true, genericallySpendableOnly: true }))
      const sponsor = coins.filter(coin => !coin.assets?.length && !coin.isSwept && coin.value >= 330).sort((a, b) => b.value - a.value)[0]
      return { ...(sponsor ? { sponsor } : {}), reservation: holdInputs(sponsor ? [sponsor] : []) }
    },
    renew: async (descriptor, persistence, sponsor, signal, sponsorReservation) => {
      const config = await pinnedEmulator()
      try {
        const receipt = await vault.renewPool(deps.wallet, descriptor, new RestEmulatorProvider(config.url), persistence, { sponsor, sponsorReservation, signal })
        reservations.release(`pool-maint:restored:${receipt.proofTxid}`)
        return receipt
      } catch (error) { if (isPoolRenewalAbandoned(error)) await releaseRestored(persistence); throw error }
    },
    prepareInputRenewal: async (descriptor, claimed) => {
      const info = await deps.wallet.getArkadeInfo({ requireLive: true })
      const client = await arkade.Arkade.connect({ arkade: { getInfo: async () => info }, indexer: deps.wallet.indexerProvider, network: deps.wallet.network })
      let minimum: number
      try { minimum = vault.poolInputPolicy(client).minTTL + 420 } finally { await client.dispose() }
      const excluded = new Set(claimed.map(point => `${point.txid}:${point.vout}`))
      const available = await indexedUnspent((await deps.wallet.getSpendableVtxos({ requireSynced: true, withRecoverable: true, genericallySpendableOnly: true }))
        .filter(coin => !excluded.has(`${coin.txid}:${coin.vout}`)))
      const inputs = available.filter(coin => coin.assets?.length === 1 && coin.assets[0].assetId === descriptor.shareAssetId &&
        coin.assets[0].amount > 0n && coin.expiresAt && coin.expiresAtHeight === undefined && coin.expiresAt.getTime() <= Date.now() + minimum * 1000).slice(0, 10)
      if (!inputs.length) return undefined
      const holds = [holdInputs(inputs)]
      try {
        const address = await deps.wallet.getAddress(), script = hex.encode(ArkAddress.decode(address).pkScript)
        const configured = Number(await deps.repos.config.get('pool_input_renewal_max_fee_sats') ?? 5000)
        const maximumFeeSats = Number.isSafeInteger(configured) && configured >= 0 && configured <= 100_000 ? BigInt(configured) : 5000n
        const estimator = new Estimator(info.fees.intentFee)
        let fee = 0n, outputSats = 0n, stable = false, sponsored = false
        for (let step = 0; step < 16; step++) {
          const total = inputs.reduce((sum, coin) => sum + BigInt(coin.value), 0n)
          outputSats = total - fee
          if (outputSats < 330n) {
            const sponsor = available.filter(coin => !coin.assets?.length && !inputs.includes(coin)).sort((a, b) => b.value - a.value)[0]
            if (!sponsor || sponsored) throw new Error('Founder share renewal needs plain bitcoin to cover its bounded batch fee')
            holds.push(holdInputs([sponsor])); inputs.push(sponsor); sponsored = true; continue
          }
          const outputs = outputSats >= 660n ? [{ amount: 330n, script }, { amount: outputSats - 330n, script }] : [{ amount: outputSats, script }]
          const expected = BigInt(estimator.evaluate(inputs.map(toOffchainInputFeeParams), [], outputs, []).satoshis)
          if (expected > maximumFeeSats) throw new Error('Founder share renewal fee exceeds pool_input_renewal_max_fee_sats')
          if (expected <= fee) { stable = true; break }
          fee = expected
        }
        if (!stable) throw new Error('Founder share renewal fee did not converge')
        return { plan: { inputs, address, outputSats, maximumFeeSats }, reservation: {
          outpoints: holds.flatMap(value => value.outpoints), release: () => holds.forEach(value => value.release()) } }
      } catch (error) { holds.forEach(value => value.release()); throw error }
    },
    restoreInputRenewalHolds: journal => {
      inputRenewal.restorePoolInputRenewalHolds(deps.wallet, journal)
      trackRestored(Transaction.fromPSBT(base64.decode(journal.proof)).id, journal.sources)
    },
    renewInputs: async (persistence, plan, signal, held) => {
      try {
        const receipt = await inputRenewal.renewPoolInputs(deps.wallet, persistence, { plan, signal,
          ...(held ? { reservation: { outpoints: held.outpoints.map(point => ({ ...point })), release: () => held.release() } } : {}) })
        reservations.release(`pool-maint:restored:${receipt.proofTxid}`)
        return receipt
      } catch (error) { if (isPoolRenewalAbandoned(error)) await releaseRestored(persistence); throw error }
    },
    restoreOperationHolds: request => vault.reservePoolSubmissionInputs(deps.wallet, request),
    operatorCoins: async (descriptor, snapshot) => {
      const nav = BigInt(snapshot.navSats), supply = BigInt(snapshot.supply)
      const coins = await indexedUnspent(await deps.wallet.getSpendableVtxos({ requireSynced: true, genericallySpendableOnly: true }))
      return coins.filter(coin => coin.assets?.length === 1 && coin.assets[0].assetId === descriptor.shareAssetId && coin.assets[0].amount > 0n)
        .map(coin => {
          const shares = coin.assets![0].amount, equity = shares * nav / supply
          return { outpoint: { txid: coin.txid, vout: coin.vout }, valueSats: String(coin.value), shares: String(shares),
            equitySats: String(equity), fullRedemptionPayoutSats: String(BigInt(coin.value) + equity) }
        })
    },
    operatorAction: async (descriptor, request) => {
      await pinnedEmulator()
      if (request.command.kind === 'sweepFees') return vault.buildPoolOperatorAction(deps.wallet, descriptor, request)
      if (!('memberOutpoint' in request)) throw new Error('Founder redemption requires an explicit share outpoint')
      const coins = await deps.wallet.getSpendableVtxos({ requireSynced: true, genericallySpendableOnly: true })
      const member = coins.find(coin => coin.txid === request.memberOutpoint.txid && coin.vout === request.memberOutpoint.vout)
      if (!member) throw new Error('The selected founder share coin is not available')
      const hold = deps.wallet.reserveVtxos([member])
      let client: arkade.Arkade | undefined
      try {
        client = await arkade.Arkade.connect({ arkade: deps.wallet.arkProvider, indexer: deps.wallet.indexerProvider, network: deps.wallet.network })
        const authorization = { validUntil: Math.floor(Date.now() / 1000) + 120, minTTL: vault.poolInputPolicy(client).minTTL }
        const staged = vault.buildPoolFreshStage(client, descriptor, member, await deps.identity.xOnlyPublicKey(),
          ArkAddress.decode(await deps.wallet.getAddress()).pkScript, authorization)
        const funding = await vault.signPoolWalletStage(deps.wallet, staged)
        const built = await vault.buildPoolOperatorAction(deps.wallet, descriptor, { ...request,
          memberOutpoint: { txid: staged.stagedInput.txid, vout: staged.stagedInput.vout } }, { stagedInput: staged.stagedInput, authorization })
        const reservation = { outpoints: [...hold.outpoints, ...built.reservation.outpoints], release: () => { hold.release(); built.reservation.release() } }
        return { ...built, reservation, stage: { version: 1, funding, authorization } }
      } catch (error) { hold.release(); throw error }
      finally { await client?.dispose() }
    },
    restoreOperatorStageHolds: stage => deps.wallet.reserveVtxos(stage.funding.inputOutpoints),
    submitOperatorStage: async (descriptor, stage, save, refundOnly = false) => {
      let current = stage
      if (!stage.funding.submitted && !stage.funding.confirmed && (refundOnly || stage.authorization.validUntil <= Math.floor(Date.now() / 1000))) return 'unsubmitted'
      if (!stage.funding.confirmed) {
        const funding = await vault.submitPoolWalletStage(deps.wallet, stage.funding, async next => {
          current = { ...current, funding: next }; await save(current)
        })
        current = { ...current, funding }
      }
      if (current.refunded) return 'refunded'
      if (!refundOnly && !current.refund && current.authorization.validUntil > Math.floor(Date.now() / 1000)) return 'funded'
      const client = await arkade.Arkade.connect({ arkade: deps.wallet.arkProvider, indexer: deps.wallet.indexerProvider, network: deps.wallet.network })
      try {
        for (const refund of [...(current.refundHistory ?? []), ...(current.refund ? [current.refund] : [])]) {
          const proof: PoolBootstrapStage = { ...refund.body, arkTxid: refund.arkTxid,
            inputOutpoints: [{ txid: current.funding.arkTxid, vout: 0 }], submitted: true }
          if (await vault.verifyPoolWalletStage(deps.wallet, proof)) {
            current = { ...current, refunded: true }; await save(current)
            return 'refunded'
          }
        }
        const prior = current.refund ? { arkTx: Transaction.fromPSBT(base64.decode(current.refund.body.arkTx)),
          checkpoints: current.refund.body.checkpointTxs.map(value => Transaction.fromPSBT(base64.decode(value))) } : undefined
        if (!prior || vault.readPoolFreshAuthorization(prior, 'refund').validUntil <= Math.floor(Date.now() / 1000)) {
          await pinnedEmulator()
          const gate = vault.createPoolFreshInput(client, descriptor)
          const coin = await vault.readPoolFreshInput(gate, descriptor, { txid: current.funding.arkTxid, vout: 0 }, deps.wallet.indexerProvider)
          const authorization = { validUntil: Math.floor(Date.now() / 1000) + 120, minTTL: vault.POOL_FRESH_MIN_TTL }
          const built = await vault.buildPoolFreshRefund(gate, descriptor, coin, authorization).build()
          const signed = await vault.authorizePoolFreshSpend(deps.identity, built, authorization, 'refund')
          current = { ...current, ...(current.refund ? { refundHistory: [...(current.refundHistory ?? []), current.refund] } : {}),
            refund: { arkTxid: signed.arkTx.id, body: { arkTx: base64.encode(signed.arkTx.toPSBT()),
            checkpointTxs: signed.checkpoints.map(checkpoint => base64.encode(checkpoint.toPSBT())) } } }
          await save(current)
        }
        const config = await pinnedEmulator()
        await withArkSubmit(async () => {
          const response = await fetch(`${config.url}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(current.refund!.body), signal: AbortSignal.timeout(25_000) })
          if (!response.ok) throw new Error(`Founder staging refund returned HTTP ${response.status}`)
          const result = await response.json() as { signedArkTx?: string }
          if (!result.signedArkTx || Transaction.fromPSBT(base64.decode(result.signedArkTx)).id !== current.refund!.arkTxid) throw new Error('Founder staging refund changed its approved transaction')
        })
        const refund = current.refund!, proof: PoolBootstrapStage = { ...refund.body, arkTxid: refund.arkTxid,
          inputOutpoints: [{ txid: current.funding.arkTxid, vout: 0 }], submitted: true }
        if (!await vault.verifyPoolWalletStage(deps.wallet, proof)) throw new Error('Founder staging refund awaits exact indexed spend proof')
        current = { ...current, refunded: true }; await save(current)
        return 'refunded'
      } finally { await client.dispose() }
    },
    read: descriptor => vault.readPoolState(deps.wallet, descriptor),
    bootstrap: async (request, persistence) => {
      await pinnedEmulator()
      return vault.bootstrapPool(deps.wallet, {
      ...request, network: deps.arkInfo.network,
      operatorUrl: process.env.ARK_SERVER_PUBLIC_URL || process.env.ARK_SERVER_URL || 'http://localhost:7070',
      operatorPubkey: Buffer.from((await deps.identity.compressedPublicKey()).slice(1)).toString('hex'),
      operatorPayoutPkScript: Buffer.from(ArkAddress.decode(await deps.wallet.getAddress()).pkScript).toString('hex'),
      }, persistence)
    },
    authorize: async (descriptor, request, game) => {
      await pinnedEmulator()
      return vault.preparePoolSubmission(deps.wallet, deps.identity, descriptor, request, game)
    },
    verify: (descriptor, request) => vault.verifyPoolSubmission(deps.wallet, descriptor, request, { loadRenewalProof }),
    resolution: (descriptor, game, houseSecret, playerSecret, mode) =>
      vault.buildPoolResolution(deps.wallet, descriptor, game, houseSecret, playerSecret, mode),
    post: async relay => {
      const config = await pinnedEmulator()
      await withArkSubmit(async () => {
        const response = await fetch(`${config.url}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(relay.body), signal: AbortSignal.timeout(25_000) })
        if (!response.ok) throw new Error(`Pool covenant service returned HTTP ${response.status}`)
        const result = await response.json() as { signedArkTx?: string }
        if (!result.signedArkTx || Transaction.fromPSBT(base64.decode(result.signedArkTx)).id !== relay.arkTxid) {
          throw new Error('Pool covenant response does not match the approved transaction')
        }
      })
    },
  }
}
