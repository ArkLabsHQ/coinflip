// @vitest-environment node
import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { Wallet } from '@arkade-os/sdk'
import type { FundedPoolDisplay } from './fundedPoolTypes'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(path.join(repoRoot, 'package.json'))
require('fake-indexeddb/auto')
const envFile = path.resolve(process.env.REGTEST_ENV || path.join(repoRoot, '.env.regtest'))
const configuration = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).flatMap(line => {
  const matched = line.match(/^([A-Z0-9_]+)=(.*)$/)
  return matched ? [[matched[1], matched[2].trim()]] : []
}))
const PROJECT = process.env.REGTEST_PROJECT || configuration.REGTEST_PROJECT || 'arkade-regtest'
const PREFIX = process.env.REGTEST_CONTAINER_PREFIX ?? configuration.REGTEST_CONTAINER_PREFIX ?? ''
const ARK = process.env.ARK_SERVER_URL || `http://localhost:${configuration.ARKD_PORT || '7070'}`
const ESPLORA = process.env.ESPLORA_URL || `http://localhost:${configuration.MEMPOOL_WEB_PORT || '3000'}/api`
const EMULATOR = process.env.EMULATOR_URL || `http://localhost:${configuration.EMULATOR_PORT || '7073'}`

class MemoryStorage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
  removeItem(key: string) { this.values.delete(key) }
  key(index: number) { return [...this.values.keys()][index] ?? null }
}

it('drives the actual browser runtime through staged subscriptions, durable recovery, a pool wager and full member redemption', async () => {
  expect(execFileSync('docker', ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', `${PREFIX}arkd`], { encoding: 'utf8' }).trim()).toBe(PROJECT)
  expect(execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', `${PREFIX}arkd`], { encoding: 'utf8' }).trim()).toBe('true')
  for (const endpoint of [ARK, ESPLORA, EMULATOR]) {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Runtime integration endpoints must be local regtest services')
  }
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const envKeys = ['DATA_DIR', 'ARK_SERVER_URL', 'ARK_SERVER_PUBLIC_URL', 'ESPLORA_URL', 'ESPLORA_PUBLIC_URL',
    'EMULATOR_URL', 'REGTEST_ENV', 'REGTEST_PROJECT', 'REGTEST_CONTAINER_PREFIX', 'VUE_APP_API_URL']
  const envBefore = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  const sdk = require('@arkade-os/sdk') as typeof import('@arkade-os/sdk')
  const express = require('express') as {
    (): { use(...middleware: unknown[]): void; listen(port: number, host: string, ready: () => void): Server }
    json(options: { limit: string }): unknown
  }
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'coinflip-funded-runtime-'))
  type ServerApi = typeof import('arkade-coinflip-server')
  let closeDb: (() => void) | undefined
  let deps: Awaited<ReturnType<ServerApi['bootstrapDeps']>> | undefined
  let listener: Server | undefined, memberWallet: Wallet | undefined
  let runtime: ReturnType<typeof import('./fundedPoolRuntime').createFundedPoolRuntime> | undefined
  const originalFetch = globalThis.fetch
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() })
    Object.assign(process.env, { DATA_DIR: dataDir, ARK_SERVER_URL: ARK, ARK_SERVER_PUBLIC_URL: ARK,
      ESPLORA_URL: ESPLORA, ESPLORA_PUBLIC_URL: ESPLORA, EMULATOR_URL: EMULATOR,
      REGTEST_ENV: envFile, REGTEST_PROJECT: PROJECT, REGTEST_CONTAINER_PREFIX: PREFIX })
    const info = await new sdk.RestOperatorProvider(ARK).getInfo()
    expect(info.network).toBe('regtest')
    const { createTestWallet, fundWallet } = await import('../../packages/e2e/src/helpers')
    const server = require('arkade-coinflip-server') as ServerApi
    closeDb = (require('arkade-coinflip-server/dist/db.js') as { closeDb(): void }).closeDb
    deps = await server.bootstrapDeps({ walletSettlementConfig: false })
    await fundWallet(deps.wallet, 400_000)
    const member = sdk.SingleKey.fromRandomBytes()
    memberWallet = await createTestWallet(member, { concurrentSpending: true })
    await fundWallet(memberWallet, 100_000)
    const address = await memberWallet.getAddress()
    await memberWallet.send({ recipients: [{ address, amount: 20_000 }, { address, amount: 20_000 }] })
    const app = express()
    app.use(express.json({ limit: '1mb' }), server.createPublicRoutes(deps), server.createPoolRoutes(deps.pool!), server.createPoolAdminRoutes(deps.pool!))
    listener = await new Promise<Server>(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)) })
    const bound = listener.address()
    if (!bound || typeof bound === 'string') throw new Error('Test coordinator did not bind an HTTP port')
    const base = `http://127.0.0.1:${bound.port}`
    process.env.VUE_APP_API_URL = base
    const request = async (path: string, method: string, body: object) => {
      const response = await originalFetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) throw new Error(`Fixture request failed HTTP${response.status}`)
      return response.json()
    }
    await request('/api/admin/pool/bootstrap', 'POST', { name: `Runtime software proof ${randomUUID().slice(0, 8)}`, initialNavSats: '100000',
      operatorFeeBps: 2000, minHouseEdgeBps: 100, maxStakeBps: 2000 })
    await request('/api/admin/pool/policy', 'PUT', { fairnessAssumption: 'honest-operator' })
    const { createFundedPoolRuntime } = await import('./fundedPoolRuntime')
    const { loadFundedPoolJournal, restorePoolHolds } = await import('./fundedPoolJournal')
    const { hex } = require('@scure/base') as typeof import('@scure/base')
    const scope = { publicKey: hex.encode(await member.xOnlyPublicKey()), network: 'regtest', operatorUrl: ARK }
    let display: FundedPoolDisplay | undefined
    const start = () => createFundedPoolRuntime({ wallet: memberWallet!, context: { ...scope, wallet: memberWallet! } as typeof scope,
      isCurrent: () => true, onState: value => { display = value } })
    runtime = start()
    await runtime.refresh()
    expect(display?.verified).toBe(true)
    const first = await runtime.prepareSubscribe(5000n)
    expect(first.transactionCount).toBe(3)
    expect(BigInt(first.cashReleasedSats!)).toBeGreaterThanOrEqual(330n)
    await runtime.confirm(first)
    const firstShares = (await memberWallet.getVtxos()).filter(coin => coin.assets?.some(asset => asset.assetId === display!.descriptor!.shareAssetId))
    expect(firstShares.length).toBe(1)
    expect(firstShares.every(coin => coin.value === 330)).toBe(true)
    expect((await memberWallet.getSpendableVtxos({ requireSynced: true })).some(coin => !coin.assets?.length && coin.value >= 330)).toBe(true)
    const second = await runtime.prepareSubscribe(5000n)
    let interrupted = false
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!interrupted && url === `${base}/api/pool/submit` && init?.method === 'POST') {
        interrupted = true
        throw new Error('Intentional runtime transport interruption before relay')
      }
      return originalFetch(input, init)
    }
    await expect(runtime.confirm(second)).rejects.toThrow('Intentional runtime transport interruption')
    globalThis.fetch = originalFetch
    const pending = (await loadFundedPoolJournal(scope)).find(entry => entry.status === 'pending')!
    expect(Object.keys(pending.context).sort()).toEqual(['network', 'operatorUrl', 'publicKey'])
    expect(!!pending.intent?.signedArkTx).toBe(true)
    await runtime.dispose(); runtime = undefined
    await memberWallet.dispose()
    memberWallet = await createTestWallet(member, { concurrentSpending: true })
    await restorePoolHolds(memberWallet, scope)
    const held = pending.intent!.memberOutpoint
    const available = await memberWallet.getSpendableVtxos({ requireSynced: true })
    expect(available.some(coin => coin.txid === held.txid && coin.vout === held.vout)).toBe(false)
    let exactReplay = false
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === `${base}/api/pool/submit` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        exactReplay = body.operationId === pending.id && body.arkTx === pending.intent!.signedArkTx &&
          JSON.stringify(body.checkpointTxs) === JSON.stringify(pending.intent!.signedCheckpoints)
      }
      return originalFetch(input, init)
    }
    runtime = start()
    await runtime.refresh()
    expect(display!.status).toBe('recovery')
    const future = pending.intent!.cashRelease!.sourceOutpoint
    expect((await memberWallet.getVtxos()).some(coin => coin.txid === future.txid && coin.vout === future.vout)).toBe(true)
    expect((await memberWallet.getSpendableVtxos({ requireSynced: true })).some(coin => coin.txid === future.txid && coin.vout === future.vout)).toBe(false)
    expect((await loadFundedPoolJournal(scope)).find(entry => entry.id === pending.id)?.intent?.cashRelease?.signedArkTx).toBeUndefined()
    await runtime.recover()
    globalThis.fetch = originalFetch
    expect(exactReplay).toBe(true)
    expect((await loadFundedPoolJournal(scope)).filter(entry => entry.status === 'confirmed')).toHaveLength(2)
    const shareCoins = (await memberWallet.getVtxos()).filter(coin => coin.assets?.some(asset => asset.assetId === display!.descriptor!.shareAssetId))
    expect(shareCoins).toHaveLength(2)
    expect(shareCoins.every(coin => coin.value === 330)).toBe(true)
    const game = await runtime.prepareBet({ playerStakeSats: 1000n, oddsN: 2, oddsLo: 0, oddsTarget: 1, choice: 0 })
    expect(game.transactionCount).toBe(2)
    await runtime.confirm(game)
    const wager = (await loadFundedPoolJournal(scope)).find(entry => entry.receipt?.kind === 'openGame')?.receipt
    expect(wager?.outcome === 'player' || wager?.outcome === 'house').toBe(true)
    expect(wager?.settlementTxid).toMatch(/^[a-f0-9]{64}$/)
    expect(wager?.payoutSats).toBe(wager?.outcome === 'player' ? game.expectedPayoutSats : '0')
    const navBeforeRedemption = BigInt(display!.navSats!), aggregateClaim = BigInt(display!.estimatedClaimSats!)
    const burn = BigInt(display!.availableShares!)
    const redemption = await runtime.prepareRedeem(burn)
    expect(redemption.transactionCount).toBe(4)
    expect(BigInt(redemption.payoutSats)).toBeGreaterThanOrEqual(aggregateClaim - 1n)
    expect(BigInt(redemption.payoutSats)).toBeLessThanOrEqual(aggregateClaim)
    await runtime.confirm(redemption)
    const receipts = (await loadFundedPoolJournal(scope)).flatMap(entry => entry.receipt ? [entry.receipt] : [])
    expect(receipts.filter(receipt => receipt.kind === 'redeem').reduce((sum, receipt) => sum + BigInt(receipt.payoutSats), 0n)).toBe(BigInt(redemption.payoutSats))
    expect(display!.memberShares).toBe('0')
    expect(display!.estimatedClaimSats).toBe('0')
    expect(BigInt(display!.navSats!)).toBe(navBeforeRedemption - BigInt(redemption.payoutSats))
  } finally {
    globalThis.fetch = originalFetch
    try {
      await runtime?.dispose()
      await memberWallet?.dispose()
      await deps?.wallet.dispose()
      if (listener) await new Promise<void>((resolve, reject) => listener!.close(error => error ? reject(error) : resolve()))
      closeDb?.()
      const resolved = path.resolve(dataDir)
      if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('coinflip-funded-runtime-')) rmSync(resolved, { recursive: true, force: true })
    } finally {
      for (const key of envKeys) { if (envBefore[key] === undefined) delete process.env[key]; else process.env[key] = envBefore[key] }
      if (storageBefore) Object.defineProperty(globalThis, 'localStorage', storageBefore)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  }
}, 180_000)
