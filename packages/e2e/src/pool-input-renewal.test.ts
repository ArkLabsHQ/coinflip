import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { base64, hex } from '@scure/base'
import { ArkAddress, Estimator, Extension, RestOperatorProvider, SettlementEventType, SingleKey, Transaction, toOffchainInputFeeParams,
  type NormalizedExtendedVirtualCoin, type Wallet } from '@arkade-os/sdk'
import { bootstrapPool, readPoolState, type PoolBootstrapJournal } from 'arkade-coinflip/dist/pool-game-vault'
import { readPoolInputRenewalReceipt, renewPoolInputs, type PoolInputRenewalJournal, type PoolInputRenewalPersistence } from 'arkade-coinflip/dist/pool-input-renewal'
import type { PoolRenewalSessionJournal } from 'arkade-coinflip/dist/pool-renewal-session'
import type { PoolBatchReplayJournal } from 'arkade-coinflip/dist/pool-batch-replay'
import { createTestWallet, fundWallet, sleep } from './helpers'

const ARK = process.env.ARK_SERVER_URL || 'http://localhost:7070'
it('renews real wallet-owned shares without issuance and returns its sponsor as separate spendable bitcoin', async () => {
  expect((await new RestOperatorProvider(ARK).getInfo()).network).toBe('regtest')
  const container = `${process.env.REGTEST_CONTAINER_PREFIX || ''}arkd`, project = process.env.REGTEST_PROJECT || 'arkade-regtest'
  expect(execFileSync('docker', ['inspect', container, '--format', '{{index .Config.Labels "com.docker.compose.project"}}'], { encoding: 'utf8' }).trim()).toBe(project)
  const directory = join(process.env.COINFLIP_TEST_OUTPUT_DIR || tmpdir(), `pool-input-renewal-${randomUUID()}`)
  mkdirSync(directory, { recursive: true })
  const load = <T>(name: string): T | undefined => existsSync(join(directory, name)) ? JSON.parse(readFileSync(join(directory, name), 'utf8')) as T : undefined
  const save = (name: string, value: unknown) => { writeFileSync(join(directory, `${name}.next`), JSON.stringify(value)); renameSync(join(directory, `${name}.next`), join(directory, name)) }
  const revision = <T extends { revision: number }>(name: string, value: T, expected: number | null): boolean => {
    if ((load<T>(name)?.revision ?? null) !== expected) return false
    save(name, value); return true
  }
  let failPreparedAcknowledgement = true, failAfterSavedNonces = true
  const persistence: PoolInputRenewalPersistence = {
    load: async () => load<PoolInputRenewalJournal>('intent.json'), save: async value => {
      save('intent.json', value)
      if (failPreparedAcknowledgement && !value.registrationAttempted) { failPreparedAcknowledgement = false; throw new Error('Lost prepared renewal journal acknowledgement') }
    },
    loadSession: async () => load<PoolRenewalSessionJournal>('session.json'), saveSession: async (value, expected) => revision('session.json', value, expected),
    loadReplay: async () => load<PoolBatchReplayJournal>('replay.json'), saveReplay: async (value, expected) => {
      const accepted = revision('replay.json', value, expected), nonces = Object.keys(load<PoolRenewalSessionJournal>('session.json')?.nonces ?? {})
      const observed = new Set(value.events.filter(event => event.type === SettlementEventType.TreeNonces).map(event => event.txid))
      if (accepted && failAfterSavedNonces && nonces.length && nonces.every(id => observed.has(id))) {
        failAfterSavedNonces = false; throw new Error('Lost aggregate nonce journal acknowledgement')
      }
      return accepted
    },
  }
  const identity = SingleKey.fromRandomBytes(), wallets: Wallet[] = []
  try {
    let wallet = await createTestWallet(identity); wallets.push(wallet)
    await fundWallet(wallet, 200_000)
    const { descriptor } = await bootstrapPool(wallet, { name: 'Native asset renewal proof', initialNavSats: '100000', operatorFeeBps: 2000,
      minHouseEdgeBps: 100, maxStakeBps: 1000, network: 'regtest', operatorUrl: ARK }, {
      load: async () => load<PoolBootstrapJournal>('bootstrap.json'), save: async value => save('bootstrap.json', value),
    })
    const member = await waitCoin(wallet, coin => coin.value === 330 && coin.assets?.length === 1 && coin.assets[0].assetId === descriptor.shareAssetId)
    const sponsor = await waitCoin(wallet, coin => !coin.assets?.length && coin.value > 50_000)
    const before = await readPoolState(wallet, descriptor), address = await wallet.getAddress(), inputs = [member, sponsor]
    const sourceShares = member.assets![0].amount, total = inputs.reduce((sum, coin) => sum + BigInt(coin.value), 0n)
    const info = await wallet.getArkadeInfo({ requireLive: true }), estimator = new Estimator(info.fees.intentFee), script = hex.encode(ArkAddress.decode(address).pkScript)
    let fee = 0n
    for (let attempt = 0; attempt < 16; attempt++) {
      const next = BigInt(estimator.evaluate(inputs.map(toOffchainInputFeeParams), [], [{ script, amount: 330n }, { script, amount: total - fee - 330n }], []).satoshis)
      if (next === fee) break
      fee = next
    }
    const initialRegister = jest.spyOn(wallet.arkProvider, 'registerIntent')
    await expect(renewPoolInputs(wallet, persistence, { plan: { inputs, address, outputSats: total - fee, maximumFeeSats: fee } })).rejects.toThrow('Lost prepared renewal journal acknowledgement')
    expect(initialRegister).not.toHaveBeenCalled()
    const preparedTxid = Transaction.fromPSBT(base64.decode((await persistence.load())!.proof)).id
    await wallet.dispose(); wallets.splice(wallets.indexOf(wallet), 1)
    wallet = await createTestWallet(identity); wallets.push(wallet)
    await waitCoin(wallet, coin => coin.txid === member.txid && coin.vout === member.vout)
    await expect(renewPoolInputs(wallet, persistence)).rejects.toThrow('Lost aggregate nonce journal acknowledgement')
    const registeredId = (await persistence.load())!.intentId, savedNonces = Object.values(load<PoolRenewalSessionJournal>('session.json')!.nonces).map(value => value.publicNonce)
    expect(registeredId).toBeTruthy()
    await wallet.dispose(); wallets.splice(wallets.indexOf(wallet), 1)
    wallet = await createTestWallet(identity); wallets.push(wallet)
    const resumedRegistration = jest.spyOn(wallet.arkProvider, 'registerIntent')
    await waitCoin(wallet, coin => coin.txid === member.txid && coin.vout === member.vout)
    const receipt = await renewPoolInputs(wallet, persistence)
    expect(resumedRegistration).not.toHaveBeenCalled(); expect(receipt.intentId).toBe(registeredId)
    expect(Object.values(load<PoolRenewalSessionJournal>('session.json')!.nonces).map(value => value.publicNonce)).toEqual(savedNonces)
    expect(receipt.proofTxid).toBe(preparedTxid)
    expect(receipt.assets).toEqual([{ assetId: descriptor.shareAssetId, amount: String(sourceShares) }])
    expect(receipt.outputs).toHaveLength(2)
    expect(receipt.outputs.map(value => value.valueSats)).toEqual(['330', String(total - fee - 330n)])
    expect(receipt.outputs[1].assets).toEqual([])
    const journal = (await persistence.load())!, proof = Transaction.fromPSBT(base64.decode(journal.proof)), groups = Extension.fromTx(proof).getAssetPacket()!.groups
    expect(groups).toHaveLength(1); expect(groups[0].isIssuance()).toBe(false); expect(groups[0].isReissuance()).toBe(false)
    expect(groups[0].controlAsset).toBeNull(); expect(groups[0].inputs[0].amount).toBe(sourceShares)
    expect(groups[0].outputs[0].amount).toBe(sourceShares)
    expect(journal.status).toBe('confirmed')
    const renewed = await waitCoin(wallet, coin => coin.txid === receipt.outputs[0].outpoint.txid && coin.vout === receipt.outputs[0].outpoint.vout)
    expect(renewed.assets).toEqual(member.assets)
    expect(renewed.commitmentTxIds).toContain(receipt.commitmentTxid)
    expect(renewed.expiresAt!.getTime()).toBeGreaterThan(member.expiresAt!.getTime())
    const plain = await waitCoin(wallet, coin => coin.txid === receipt.outputs[1].outpoint.txid && coin.vout === receipt.outputs[1].outpoint.vout)
    expect(plain.assets ?? []).toHaveLength(0)
    const after = (await readPoolState(wallet, descriptor))!
    expect(after.outpoint).toEqual(before!.outpoint)
    await wallet.dispose(); wallets.splice(wallets.indexOf(wallet), 1)
    const restored = await createTestWallet(identity); wallets.push(restored)
    const spy = jest.spyOn(restored.arkProvider, 'registerIntent')
    expect(await renewPoolInputs(restored, persistence)).toEqual(receipt)
    expect(await readPoolInputRenewalReceipt(restored, journal)).toEqual(receipt)
    expect(spy).not.toHaveBeenCalled()
    console.info('[pool-input-renewal-proof]', JSON.stringify({ proofTxid: receipt.proofTxid, commitmentTxid: receipt.commitmentTxid,
      returnedSats: receipt.outputSats, shares: String(sourceShares), carrier: receipt.outputs[0].valueSats, plainSats: receipt.outputs[1].valueSats,
      expiresBefore: member.expiresAt!.getTime(), expiresAfter: renewed.expiresAt!.getTime(), restored: true, aggregateNonceRestart: true }))
  } finally { for (const wallet of wallets) await wallet.dispose() }
}, 240_000)

async function waitCoin(wallet: Wallet, predicate: (coin: NormalizedExtendedVirtualCoin) => boolean): Promise<NormalizedExtendedVirtualCoin> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const coin = (await wallet.getSpendableVtxos({ requireSynced: true })).find(predicate)
    if (coin) return coin
    await sleep(500)
  }
  throw new Error('Expected wallet output is not indexed and spendable')
}
