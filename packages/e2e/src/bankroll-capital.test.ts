import { base64, hex } from '@scure/base'
import {
  ArkAddress, Extension, RestEmulatorProvider, RestIndexerProvider, RestOperatorProvider,
  SingleKey, Transaction, arkade, asset, networks, buildOffchainTx,
  type ArkTxInput, type NormalizedExtendedVirtualCoin, type Wallet,
} from '@arkade-os/sdk'
import {
  bankrollStatePacket, buildBankrollRedemption, buildBankrollSubscription, createBankrollVault,
  readBankrollVaultPosition, verifyBankrollBootstrap,
  type BankrollVaultAssets, type BankrollVaultPosition,
} from 'arkade-coinflip/dist/bankroll-vault'
import { prepareSettleForEmulator } from 'arkade-coinflip'
import { createTestWallet, fundWallet, sleep } from './helpers'
import { signCheckpointsByOutpoint } from './test-helpers/checkpoint-signers'

const ARK = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const EMULATOR = process.env.EMULATOR_URL || 'http://localhost:7073'
const { AssetGroup, AssetInput, AssetOutput, AssetId, AssetRef, Packet } = asset
const INITIAL_NAV = 100_000n
const INITIAL_SHARES = INITIAL_NAV * 1_000_000n

it('enforces a real control-token vault from bootstrap through subscription, transfer and final retirement', async () => {
  const operator = new RestOperatorProvider(ARK)
  const indexer = new RestIndexerProvider(ARK)
  const emulator = new RestEmulatorProvider(EMULATOR)
  const wallets: Wallet[] = []
  const clients: arkade.Arkade[] = []
  const handles: { off(): void }[] = []
  try {
    const founder = SingleKey.fromRandomBytes()
    const member = SingleKey.fromRandomBytes()
    const founderWallet = await createTestWallet(founder)
    const memberWallet = await createTestWallet(member)
    wallets.push(founderWallet, memberWallet)
    await fundWallet(founderWallet, 200_000)
    await fundWallet(memberWallet, 100_000)
    const founderClient = await arkade.Arkade.connect({
      arkade: operator, indexer, emulator, identity: founder, network: networks.regtest,
      contractManager: await founderWallet.getContractManager(),
    })
    const memberClient = await arkade.Arkade.connect({
      arkade: operator, indexer, emulator, identity: member, network: networks.regtest,
      contractManager: await memberWallet.getContractManager(),
    })
    clients.push(founderClient, memberClient)
    const founderScript = ArkAddress.decode(await founderWallet.getAddress()).pkScript
    const memberScript = ArkAddress.decode(await memberWallet.getAddress()).pkScript
    const funding = await waitCoin(founderWallet, coin => BigInt(coin.value) > INITIAL_NAV + 330n)
    const genesis = await ordinary(founderClient, [funding], [
      { script: founderScript, amount: INITIAL_NAV },
      { script: founderScript, amount: BigInt(funding.value) - INITIAL_NAV },
    ], [Packet.create([
        AssetGroup.create(null, null, [], [AssetOutput.create(0, 1n)], []),
        AssetGroup.create(null, AssetRef.fromGroupIndex(0), [], [AssetOutput.create(1, INITIAL_SHARES)], []),
      ])])
    const assets: BankrollVaultAssets = {
      controlAssetId: AssetId.create(genesis.txid, 0).toString(),
      shareAssetId: AssetId.create(genesis.txid, 1).toString(),
    }
    const initialControl = await waitCoin(founderWallet, coin => coin.txid === genesis.txid && coin.vout === 0)
    const initialShareCoin = await waitCoin(founderWallet, coin => coin.txid === genesis.txid && coin.vout === 1)
    const vault = createBankrollVault(founderClient, assets)
    const memberVault = createBankrollVault(memberClient, assets)
    const events: string[] = []
    handles.push(await vault.on('vtxo_received', () => { events.push('received') }))
    handles.push(await vault.on('vtxo_spent', () => { events.push('spent') }))
    await memberVault.register()
    const activation = await ordinary(founderClient, [initialControl, initialShareCoin], [
      { script: vault.pkScript, amount: INITIAL_NAV },
      { script: founderScript, amount: BigInt(initialShareCoin.value) },
    ], [Packet.create([
        AssetGroup.create(AssetId.fromString(assets.controlAssetId), null,
          [AssetInput.create(0, 1n)], [AssetOutput.create(0, 1n)], []),
        AssetGroup.create(AssetId.fromString(assets.shareAssetId), null,
          [AssetInput.create(1, INITIAL_SHARES)], [AssetOutput.create(1, INITIAL_SHARES)], []),
      ]), bankrollStatePacket(INITIAL_SHARES)])
    let position = await waitPosition(vault, assets, indexer, activation.txid)
    expect(position.navSats).toBe(INITIAL_NAV)
    expect(position.supply).toBe(INITIAL_SHARES)
    await verifyBankrollBootstrap(vault, assets, {
      bootstrapTxid: activation.txid, checkpointPsbts: activation.signedCheckpointTxs.slice().reverse(),
    }, indexer)
    const forgedCheckpoint = new Transaction({ version: 3 })
    forgedCheckpoint.addInput({ txid: new Uint8Array(32).fill(7), index: 1 })
    forgedCheckpoint.addOutput({ script: founderScript, amount: INITIAL_NAV })
    await expect(verifyBankrollBootstrap(vault, assets, {
      bootstrapTxid: activation.txid,
      checkpointPsbts: [activation.signedCheckpointTxs[0], base64.encode(forgedCheckpoint.toPSBT())],
    }, indexer)).rejects.toThrow()

    await memberWallet.send({ recipients: [{ address: vault.address, amount: 5000 }] })
    const restoredClient = await arkade.Arkade.connect({ arkade: operator, indexer, emulator, network: networks.regtest })
    clients.push(restoredClient)
    const restored = createBankrollVault(restoredClient, assets)
    expect(hex.encode(restored.pkScript)).toBe(hex.encode(vault.pkScript))
    expect((await readBankrollVaultPosition(restored, assets, indexer))?.navSats).toBe(INITIAL_NAV)
    expect((await restored.getUtxos()).filter(coin => !coin.isSpent).length).toBeGreaterThanOrEqual(2)
    const unavailableIndexer = {
      getVirtualTxs: indexer.getVirtualTxs.bind(indexer),
      getVtxos: async (options: Parameters<RestIndexerProvider['getVtxos']>[0]) => {
        const response = await indexer.getVtxos(options)
        return { ...response, vtxos: response.vtxos.map(coin =>
          coin.txid === activation.txid && coin.vout === 0 ? { ...coin, isSwept: true } : coin) }
      },
    }
    await expect(readBankrollVaultPosition(restored, assets, unavailableIndexer)).rejects.toThrow(/recover|unavailable/i)
    const memberFunding = await waitCoin(memberWallet, coin => !coin.assets?.length && coin.value >= 90_000)
    const split = await ordinary(memberClient, [memberFunding], [
      { script: memberScript, amount: 40_000n },
      { script: memberScript, amount: BigInt(memberFunding.value) - 40_000n },
    ])
    const depositCoin = await waitCoin(memberWallet, coin => coin.txid === split.txid && coin.vout === 0)
    const staleFunding = await waitCoin(memberWallet, coin => coin.txid === split.txid && coin.vout === 1)
    await expect(ordinary(memberClient, [staleFunding], [
      { script: memberScript, amount: BigInt(staleFunding.value) },
    ], [Packet.create([AssetGroup.create(AssetId.fromString(assets.shareAssetId), null, [],
      [AssetOutput.create(0, 1n)], [])])])).rejects.toThrow(/control/i)
    await waitCoin(memberWallet, coin => coin.txid === staleFunding.txid && coin.vout === staleFunding.vout)
    const deposit = 25_000n
    const minted = 25_000_000_000n
    const build = () => buildBankrollSubscription(memberVault, assets, position, depositCoin, deposit, minted).builder
    for (const attack of ['redirect', 'NAV', 'counter', 'mint'] as const) {
      const built = await build().build()
      if (attack === 'redirect') built.arkTx.updateOutput(1, { script: founderScript })
      if (attack === 'NAV') {
        built.arkTx.updateOutput(0, { amount: INITIAL_NAV + deposit - 1n })
        built.arkTx.updateOutput(1, { amount: BigInt(depositCoin.value) - deposit + 1n })
      }
      if (attack === 'counter') replacePacket(built.arkTx, bankrollStatePacket(INITIAL_SHARES + minted + 1n))
      if (attack === 'mint') replacePacket(built.arkTx, Packet.create([
        AssetGroup.create(AssetId.fromString(assets.controlAssetId), null,
          [AssetInput.create(0, 1n)], [AssetOutput.create(0, 1n)], []),
        AssetGroup.create(AssetId.fromString(assets.shareAssetId), null, [], [AssetOutput.create(1, minted + 1n)], []),
      ]))
      built.arkTx = await member.sign(built.arkTx, [1])
      built.checkpoints[1] = await member.sign(built.checkpoints[1], [0])
      const response = await fetch(`${EMULATOR}/v1/tx`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await prepareSettleForEmulator(built, indexer)),
        signal: AbortSignal.timeout(30_000),
      })
      const refusal = await response.json()
      expect(response.status).toBe(500)
      expect(refusal).toMatchObject({ code: 13, message: 'internal error' })
      expect((await readBankrollVaultPosition(restored, assets, indexer))?.coin.txid).toBe(activation.txid)
    }
    const stalePosition = position
    const subscribed = await build().send()
    position = await waitPosition(restored, assets, indexer, subscribed.txid)
    expect(position.navSats).toBe(125_000n)
    expect(position.supply).toBe(125_000_000_000n)
    const stale = buildBankrollSubscription(memberVault, assets, stalePosition, staleFunding, deposit, minted)
    await expect(stale.builder.send()).rejects.toThrow()
    expect((await readBankrollVaultPosition(restored, assets, indexer))?.coin.txid).toBe(subscribed.txid)
    const shares = await waitCoin(memberWallet, coin => coin.txid === subscribed.txid && coin.vout === 1)
    expect(held(shares, assets.shareAssetId)).toBe(minted)
    const burnShares = 10_000_000_123n
    const remainingShares = minted - burnShares
    const redemption = buildBankrollRedemption(memberVault, assets, position, shares, burnShares, 10_000n)
    expect(redemption.payoutSats).toBe(10_000n)
    for (const attack of ['payout', 'redirect'] as const) {
      const bad = await redemption.builder.build()
      if (attack === 'payout') {
        bad.arkTx.updateOutput(0, { amount: position.navSats - 10_001n })
        bad.arkTx.updateOutput(1, { amount: BigInt(shares.value) + 10_001n })
      } else {
        bad.arkTx.updateOutput(1, { script: founderScript })
      }
      bad.arkTx = await member.sign(bad.arkTx, [1])
      bad.checkpoints[1] = await member.sign(bad.checkpoints[1], [0])
      const response = await fetch(`${EMULATOR}/v1/tx`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await prepareSettleForEmulator(bad, indexer)),
        signal: AbortSignal.timeout(30_000),
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ code: 13, message: 'internal error' })
      expect((await readBankrollVaultPosition(restored, assets, indexer))?.coin.txid).toBe(subscribed.txid)
    }
    const redeemed = await redemption.builder.send()
    position = await waitPosition(restored, assets, indexer, redeemed.txid)
    expect(position.navSats).toBe(115_000n)
    expect(position.supply).toBe(INITIAL_SHARES + remainingShares)
    const shareChange = await waitCoin(memberWallet, coin => coin.txid === redeemed.txid && coin.vout === 1)
    expect(shareChange.value).toBe(shares.value + 10_000)
    expect(held(shareChange, assets.shareAssetId)).toBe(remainingShares)
    const transferred = await ordinary(memberClient, [shareChange], [
      { script: founderScript, amount: BigInt(shareChange.value) },
    ], [shareTransfer(assets.shareAssetId, [remainingShares])])
    const received = await waitCoin(founderWallet, coin => coin.txid === transferred.txid && coin.vout === 0)
    const original = await waitCoin(founderWallet, coin => coin.txid === activation.txid && coin.vout === 1)
    const merged = await ordinary(founderClient, [original, received], [
      { script: founderScript, amount: BigInt(original.value + received.value) },
    ], [shareTransfer(assets.shareAssetId, [INITIAL_SHARES, remainingShares])])
    const allShares = await waitCoin(founderWallet, coin => coin.txid === merged.txid && coin.vout === 0)
    expect(held(allShares, assets.shareAssetId)).toBe(position.supply)
    const closed = await buildBankrollRedemption(vault, assets, position, allShares, position.supply, position.navSats).builder.send()
    const final = await waitCoin(founderWallet, coin => coin.txid === closed.txid && coin.vout === 0)
    expect(final.value).toBe(allShares.value + Number(position.navSats))
    expect(final.assets ?? []).toEqual([])
    await waitUntil(async () => (await readBankrollVaultPosition(restored, assets, indexer)) === undefined)
    await waitUntil(async () => events.includes('received') && events.includes('spent'))
    expect((await restored.getUtxos()).some(coin => coin.value === 5000)).toBe(true)
    console.info('[bankroll-capital]', { genesis: genesis.txid, bootstrap: activation.txid,
      subscription: subscribed.txid, partialRedemption: redeemed.txid, retirement: closed.txid, assets })
  } finally {
    handles.forEach(handle => handle.off())
    await Promise.all(clients.map(client => client.dispose()))
    await Promise.all(wallets.map(wallet => wallet.dispose()))
  }
}, 600_000)

function input(coin: NormalizedExtendedVirtualCoin): ArkTxInput {
  return { txid: coin.txid, vout: coin.vout, value: coin.value,
    tapLeafScript: coin.forfeitTapLeafScript, tapTree: coin.tapTree }
}

async function ordinary(
  client: arkade.Arkade, coins: NormalizedExtendedVirtualCoin[],
  outputs: { script: Uint8Array; amount: bigint }[],
  packets: { type(): number; serialize(): Uint8Array }[] = [],
): Promise<{ txid: string; signedCheckpointTxs: string[] }> {
  const { identity, arkProvider } = client
  if (!identity || !arkProvider.submitTx || !arkProvider.finalizeTx) throw new Error('Ordinary spend needs a signer and operator')
  const built = buildOffchainTx(coins.map(input),
    [...outputs, ...(packets.length ? [Extension.create(packets).txOut()] : [])], client.checkpoint)
  const signed = await identity.sign(built.arkTx)
  const submitted = await arkProvider.submitTx(base64.encode(signed.toPSBT()), built.checkpoints.map(tx => base64.encode(tx.toPSBT())))
  const signedCheckpointTxs = await signCheckpointsByOutpoint(submitted.signedCheckpointTxs,
    built.checkpoints.map(checkpoint => ({ checkpoint, identity })))
  await arkProvider.finalizeTx(submitted.arkTxid, signedCheckpointTxs)
  return { txid: submitted.arkTxid, signedCheckpointTxs }
}

function held(coin: NormalizedExtendedVirtualCoin, id: string): bigint {
  return coin.assets?.find(item => item.assetId === id)?.amount ?? 0n
}

function shareTransfer(id: string, amounts: bigint[]): asset.Packet {
  return Packet.create([AssetGroup.create(AssetId.fromString(id), null,
    amounts.map((amount, vin) => AssetInput.create(vin, amount)),
    [AssetOutput.create(0, amounts.reduce((sum, amount) => sum + amount, 0n))], [])])
}

function replacePacket(tx: Transaction, packet: { type(): number; serialize(): Uint8Array }): void {
  for (let index = 0; index < tx.outputsLength; index++) {
    const script = tx.getOutput(index).script
    if (!script || !Extension.isExtension(script)) continue
    const packets = Extension.fromBytes(script).getPackets()
    if (!packets.some(item => item.type() === packet.type())) throw new Error('Packet to replace is missing')
    tx.updateOutput(index, Extension.create(packets.map(item => item.type() === packet.type() ? packet : item)).txOut())
    return
  }
  throw new Error('Extension is missing')
}

async function waitCoin(wallet: Wallet, predicate: (coin: NormalizedExtendedVirtualCoin) => boolean): Promise<NormalizedExtendedVirtualCoin> {
  let found: NormalizedExtendedVirtualCoin | undefined
  await waitUntil(async () => { found = (await wallet.getSpendableVtxos()).find(predicate); return !!found })
  return found!
}

async function waitPosition(contract: arkade.ArkadeContract, assets: BankrollVaultAssets, indexer: RestIndexerProvider, txid: string): Promise<BankrollVaultPosition> {
  let found: BankrollVaultPosition | undefined
  await waitUntil(async () => { found = await readBankrollVaultPosition(contract, assets, indexer); return found?.coin.txid === txid })
  return found!
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 45_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for canonical vault state')
    await sleep(500)
  }
}
