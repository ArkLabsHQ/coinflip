import { createHash, randomBytes, randomUUID } from 'crypto'
import { base64, hex } from '@scure/base'
import {
  ArkAddress, Extension, RestEmulatorProvider, RestIndexerProvider, RestOperatorProvider,
  SingleKey, Transaction, UnknownPacket, arkade, asset, networks, buildOffchainTx,
  type ArkTxInput, type NormalizedExtendedVirtualCoin, type Wallet,
} from '@arkade-os/sdk'
import { packets, prepareSettleForEmulator, quoteCommittedEconomics } from 'arkade-coinflip'
import {
  bootstrapPool, buildPoolFeeSweep, buildPoolOpenGame, buildPoolPlayerReveal, buildPoolRedemption,
  buildPoolRefund, buildPoolSettlement, buildPoolSubscription, buildPoolTimeout,
  createPoolGameVault, poolStatePackets, readPoolGamePosition,
  authorizePoolFreshSpend, readPoolFreshAuthorization,
  buildPoolFreshRefund, createPoolFreshInput,
  type PoolGameDescriptor, type PoolGamePosition,
  type PoolBootstrapJournal,
} from 'arkade-coinflip/dist/pool-game-vault'
import type { PoolPreparedGame } from 'arkade-coinflip/dist/pool-protocol'
import { createTestWallet, fundWallet, sleep } from './helpers'
import { signCheckpointsByOutpoint } from './test-helpers/checkpoint-signers'
import { stagePoolTestInput, submitPoolTestSpend } from './test-helpers/pool-fresh'

const ARK = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const EMULATOR = process.env.EMULATOR_URL || 'http://localhost:7073'
const { AssetGroup, AssetInput, AssetOutput, AssetId, Packet } = asset
const INITIAL_SHARES = 100_000_000_000n
type Built = Awaited<ReturnType<arkade.ArkadeTransactionBuilder['build']>>
const digest = (value: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(value).digest())
const secret = (digit: number): Uint8Array => packets.encodeReveal(digit, new Uint8Array(randomBytes(16)))

it('enforces a funded pool through games, carried losses, fees, refunds and complete retirement', async () => {
  const operator = new RestOperatorProvider(ARK)
  const indexer = new RestIndexerProvider(ARK)
  const emulator = new RestEmulatorProvider(EMULATOR)
  const founder = SingleKey.fromRandomBytes()
  const member = SingleKey.fromRandomBytes()
  const wallets: Wallet[] = []
  const clients: arkade.Arkade[] = []
  try {
    const founderWallet = await createTestWallet(founder)
    const memberWallet = await createTestWallet(member)
    wallets.push(founderWallet, memberWallet)
    await fundWallet(founderWallet, 200_000)
    await fundWallet(memberWallet, 300_000)
    const founderClient = await arkade.Arkade.connect({ arkade: operator, indexer, emulator,
      identity: founder, network: networks.regtest, contractManager: await founderWallet.getContractManager() })
    const memberClient = await arkade.Arkade.connect({ arkade: operator, indexer, emulator,
      identity: member, network: networks.regtest, contractManager: await memberWallet.getContractManager() })
    const restoredClient = await arkade.Arkade.connect({ arkade: operator, indexer, emulator, network: networks.regtest })
    clients.push(founderClient, memberClient, restoredClient)
    let bootstrapJournal: PoolBootstrapJournal | undefined
    const bootstrapped = await bootstrapPool(founderWallet, { name: 'Funded regtest pool', initialNavSats: '100000',
      operatorFeeBps: 2000, minHouseEdgeBps: 100, maxStakeBps: 2000, network: 'regtest', operatorUrl: ARK }, {
      load: async () => bootstrapJournal,
      save: async value => { bootstrapJournal = structuredClone(value) },
    })
    const { descriptor } = bootstrapped
    const vault = createPoolGameVault(founderClient, descriptor)
    const memberVault = createPoolGameVault(memberClient, descriptor)
    const restored = createPoolGameVault(restoredClient, descriptor)
    const founderScript = ArkAddress.decode(await founderWallet.getAddress()).pkScript
    const memberScript = ArkAddress.decode(await memberWallet.getAddress()).pkScript
    let position = await waitHead(restored, descriptor, indexer)
    expect(position.state).toMatchObject({ supply: INITIAL_SHARES, navSats: 100_000n,
      accruedFeesSats: 0n, carriedLossSats: 0n, phase: 'idle' })
    expect(position.coin.value).toBe(100_330)
    expect(hex.encode(restored.pkScript)).toBe(hex.encode(vault.pkScript))

    const memberFunding = await waitCoin(memberWallet, coin => !coin.assets?.length && coin.value > 290_000)
    const split = await ordinary(memberClient, [memberFunding], [
      { script: memberScript, amount: 40_000n }, { script: memberScript, amount: 10_000n },
      { script: memberScript, amount: BigInt(memberFunding.value) - 50_000n },
    ])
    const deposit = await stagePoolTestInput(memberClient, descriptor, await waitCoin(memberWallet, coin => coin.txid === split.txid && coin.vout === 0))
    const depositCoin = deposit.coin
    const staleCoin = await waitCoin(memberWallet, coin => coin.txid === split.txid && coin.vout === 1)
    const subscription = () => buildPoolSubscription(memberVault, descriptor, position, depositCoin, 25_000n, 25_000_000_000n, deposit.authorization).builder
    for (const attack of ['destination', 'supply', 'NAV'] as const) {
      const bad = await subscription().build()
      if (attack === 'destination') bad.arkTx.updateOutput(1, { script: founderScript })
      if (attack === 'supply') replacePacket(bad.arkTx, new UnknownPacket(32, arkade.BigNum.encode(125_000_000_001n)))
      if (attack === 'NAV') {
        bad.arkTx.updateOutput(0, { amount: 125_329n })
        bad.arkTx.updateOutput(1, { amount: BigInt(depositCoin.value) - 24_999n })
      }
      await refused(bad, position, restored, descriptor, indexer, member)
    }
    const stalePosition = position
    const joined = await submitPoolTestSpend(memberClient, await subscription().build(), deposit.authorization)
    position = await waitHead(restored, descriptor, indexer, joined.txid)
    expect(position.state).toMatchObject({ navSats: 125_000n, supply: 125_000_000_000n })
    const stagedStale = await stagePoolTestInput(memberClient, descriptor, staleCoin)
    await expect(submitPoolTestSpend(memberClient, await buildPoolSubscription(memberVault, descriptor, stalePosition, stagedStale.coin, 1000n, undefined, stagedStale.authorization).builder.build(), stagedStale.authorization)).rejects.toThrow()
    expect((await waitHead(restored, descriptor, indexer)).coin.txid).toBe(joined.txid)
    expect(stagedStale.coin.value).toBe(staleCoin.value)
    const recoveredStage = await submitPoolTestSpend(memberClient, await buildPoolFreshRefund(createPoolFreshInput(memberClient, descriptor), descriptor, stagedStale.coin, stagedStale.authorization).build(), stagedStale.authorization, member, undefined, 'refund')
    expect((await waitCoin(memberWallet, coin => coin.txid === recoveredStage.txid && coin.vout === 0)).value).toBe(staleCoin.value)
    await memberWallet.send({ recipients: [{ address: vault.address, amount: 5000 }] })
    expect((await waitHead(restored, descriptor, indexer)).state.navSats).toBe(125_000n)

    async function open(stake: bigint, playerDigit: number, cancelSeconds = 30, finalSeconds = 60) {
      const playerSecret = secret(playerDigit)
      const houseSecret = secret(0)
      const playerCoin = await waitCoin(memberWallet, coin => !coin.assets?.length &&
        !(coin.txid === staleCoin.txid && coin.vout === staleCoin.vout) && coin.value >= Number(stake + 330n))
      const now = Math.floor(Date.now() / 1000)
      const terms: PoolPreparedGame = { gameId: randomUUID(), expectedHead: { txid: position.coin.txid, vout: position.coin.vout },
        playerHash: hex.encode(digest(playerSecret)), houseHash: hex.encode(digest(houseSecret)),
        playerPubkey: hex.encode(await member.xOnlyPublicKey()), playerPayoutAddress: await memberWallet.getAddress(),
        playerStakeSats: String(stake), houseStakeSats: String(stake), oddsN: 100, oddsLo: 0, oddsTarget: 49,
        cancelAt: now + cancelSeconds, finalAt: now + finalSeconds, expiresAt: Date.now() + cancelSeconds * 1000,
        economics: quoteCommittedEconomics({ playerStake: Number(stake), houseStake: Number(stake), oddsN: 100, oddsLo: 0, oddsTarget: 49 }) }
      const staged = await stagePoolTestInput(memberClient, descriptor, playerCoin)
      const built = await buildPoolOpenGame(vault, descriptor, position, staged.coin, terms, staged.authorization).builder.build()
      const { txid } = await submitPoolTestSpend(memberClient, built, staged.authorization, member, founder)
      position = await waitHead(restored, descriptor, indexer, txid)
      expect(position.state.phase).toBe('funded')
      return { playerSecret, houseSecret, terms, txid }
    }

    const playerWin = await open(10_000n, 0)
    const winning = () => buildPoolSettlement(vault, descriptor, position, playerWin.playerSecret, playerWin.houseSecret)
    expect(winning().winner).toBe('player')
    for (const attack of ['reveal', 'swapped', 'payout'] as const) {
      const bad = await winning().builder.build()
      if (attack === 'reveal') replacePacket(bad.arkTx, new UnknownPacket(16, secret(1)))
      if (attack === 'swapped') {
        replacePacket(bad.arkTx, new UnknownPacket(16, playerWin.houseSecret))
        replacePacket(bad.arkTx, new UnknownPacket(17, playerWin.playerSecret))
      }
      if (attack === 'payout') {
        bad.arkTx.updateOutput(0, { amount: BigInt(position.coin.value) - 20_001n })
        bad.arkTx.updateOutput(1, { amount: 20_001n })
      }
      await refused(bad, position, restored, descriptor, indexer)
    }
    const playerPaid = await winning().builder.send()
    position = await waitHead(restored, descriptor, indexer, playerPaid.txid)
    expect(position.state).toMatchObject({ navSats: 115_000n, carriedLossSats: 10_000n, accruedFeesSats: 0n })
    expect((await waitCoin(memberWallet, coin => coin.txid === playerPaid.txid && coin.vout === 1)).value).toBe(20_000)

    const poolWin = await open(15_000n, 70)
    const gaining = () => buildPoolSettlement(vault, descriptor, position, poolWin.playerSecret, poolWin.houseSecret)
    expect(gaining().winner).toBe('pool')
    const feeForgery = await gaining().builder.build()
    replacePacket(feeForgery.arkTx, new UnknownPacket(34, fixed(1001n, 4)))
    await refused(feeForgery, position, restored, descriptor, indexer)
    const poolPaid = await gaining().builder.send()
    position = await waitHead(restored, descriptor, indexer, poolPaid.txid)
    expect(position.state).toMatchObject({ navSats: 129_000n, carriedLossSats: 0n, accruedFeesSats: 1000n })
    expect(position.coin.value).toBe(130_330)
    const swept = await buildPoolFeeSweep(vault, descriptor, position).send()
    position = await waitHead(restored, descriptor, indexer, swept.txid)
    expect(position.state).toMatchObject({ navSats: 129_000n, accruedFeesSats: 0n })
    expect((await waitCoin(founderWallet, coin => coin.txid === swept.txid && coin.vout === 1)).value).toBe(1000)

    const smallWin = await open(330n, 70)
    const smallPaid = await buildPoolSettlement(vault, descriptor, position, smallWin.playerSecret, smallWin.houseSecret).builder.send()
    position = await waitHead(restored, descriptor, indexer, smallPaid.txid)
    expect(position.state).toMatchObject({ navSats: 129_264n, accruedFeesSats: 66n })
    const refund = await open(1000n, 0, 5, 10)
    const prematureRefund = await earlyTerminal('refundGame', vault, descriptor, position).build()
    await refused(prematureRefund, position, restored, descriptor, indexer)
    await waitUntil(async () => Math.floor(Date.now() / 1000) > refund.terms.cancelAt)
    const refunded = await buildPoolRefund(vault, descriptor, position).builder.send()
    position = await waitHead(restored, descriptor, indexer, refunded.txid)
    expect(position.state).toMatchObject({ navSats: 129_264n, accruedFeesSats: 66n, carriedLossSats: 0n })
    expect((await waitCoin(memberWallet, coin => coin.txid === refunded.txid && coin.vout === 1)).value).toBe(1000)

    const contest = await open(1000n, 0, 5, 10)
    const revealed = await buildPoolPlayerReveal(vault, descriptor, position, contest.playerSecret).send()
    position = await waitHead(restored, descriptor, indexer, revealed.txid)
    expect(position.state.phase).toBe('contest')
    expect(position.state.playerSecret).toEqual(contest.playerSecret)
    await refused(await earlyTerminal('playerTimeout', vault, descriptor, position).build(), position, restored, descriptor, indexer)
    await waitUntil(async () => Math.floor(Date.now() / 1000) > contest.terms.finalAt)
    const timedOut = await buildPoolTimeout(vault, descriptor, position).builder.send()
    position = await waitHead(restored, descriptor, indexer, timedOut.txid)
    expect(position.state).toMatchObject({ navSats: 128_264n, carriedLossSats: 1000n, accruedFeesSats: 66n })
    expect((await waitCoin(memberWallet, coin => coin.txid === timedOut.txid && coin.vout === 1)).value).toBe(2000)

    const memberShares = await waitCoin(memberWallet, coin => held(coin, descriptor.shareAssetId) === 25_000_000_000n)
    const stagedShares = await stagePoolTestInput(memberClient, descriptor, memberShares)
    const partial = buildPoolRedemption(memberVault, descriptor, position, stagedShares.coin, 10_000_000_000n, undefined, stagedShares.authorization)
    expect(partial.payoutSats).toBe(10_261n)
    const redeemed = await submitPoolTestSpend(memberClient, await partial.builder.build(), stagedShares.authorization)
    position = await waitHead(restored, descriptor, indexer, redeemed.txid)
    expect(position.state).toMatchObject({ navSats: 118_003n, supply: 115_000_000_000n, carriedLossSats: 920n, accruedFeesSats: 66n })
    const remaining = await waitCoin(memberWallet, coin => coin.txid === redeemed.txid && coin.vout === 1)
    expect(held(remaining, descriptor.shareAssetId)).toBe(15_000_000_000n)
    const transferred = await ordinary(memberClient, [remaining], [{ script: founderScript, amount: BigInt(remaining.value) }],
      [shareTransfer(descriptor.shareAssetId, [15_000_000_000n])])
    const received = await waitCoin(founderWallet, coin => coin.txid === transferred.txid && coin.vout === 0)
    const original = await waitCoin(founderWallet, coin => held(coin, descriptor.shareAssetId) === INITIAL_SHARES)
    const merged = await ordinary(founderClient, [original, received], [{ script: founderScript, amount: BigInt(original.value + received.value) }],
      [shareTransfer(descriptor.shareAssetId, [INITIAL_SHARES, 15_000_000_000n])])
    const allShares = await waitCoin(founderWallet, coin => coin.txid === merged.txid && coin.vout === 0)
    const stagedFinal = await stagePoolTestInput(founderClient, descriptor, allShares)
    const final = await submitPoolTestSpend(founderClient, await buildPoolRedemption(vault, descriptor, position, stagedFinal.coin, position.state.supply, undefined, stagedFinal.authorization).builder.build(), stagedFinal.authorization)
    expect((await waitCoin(founderWallet, coin => coin.txid === final.txid && coin.vout === 0)).value).toBe(allShares.value + 118_003)
    expect((await waitCoin(founderWallet, coin => coin.txid === final.txid && coin.vout === 1)).value).toBe(396)
    await waitUntil(async () => (await readPoolGamePosition(restored, descriptor, indexer)) === undefined)
    const closed = Transaction.fromPSBT(base64.decode((await indexer.getVirtualTxs([final.txid])).txs[0]))
    expect(Extension.fromTx(closed).getAssetPacket()!.groups.every(group => group.outputs.length === 0)).toBe(true)
    expect((await restored.getUtxos()).some(coin => coin.value === 5000)).toBe(true)
    console.info('[pool-game-vault]', { bootstrap: bootstrapped.snapshot, subscribed: joined.txid,
      playerWin: playerPaid.txid, poolWin: poolPaid.txid, sweep: swept.txid, refund: refunded.txid,
      timeout: timedOut.txid, partial: redeemed.txid, retirement: final.txid })
  } finally {
    await Promise.all(clients.map(client => client.dispose()))
    await Promise.all(wallets.map(wallet => wallet.dispose()))
  }
}, 600_000)

function fixed(value: bigint, width: number): Uint8Array {
  const bytes = arkade.BigNum.encode(value)
  if (bytes.length > width) throw new Error('Fixed integer overflow')
  const result = new Uint8Array(width)
  result.set(bytes)
  return result
}

function controlPacket(descriptor: PoolGameDescriptor): asset.Packet {
  return Packet.create([AssetGroup.create(AssetId.fromString(descriptor.controlAssetId), null,
    [AssetInput.create(0, 1n)], [AssetOutput.create(0, 1n)], [])])
}

function earlyTerminal(name: 'refundGame' | 'playerTimeout', contract: arkade.ArkadeContract, descriptor: PoolGameDescriptor,
  position: PoolGamePosition): arkade.ArkadeTransactionBuilder {
  const game = position.state.game!
  const payout = game.playerStakeSats + (name === 'playerTimeout' ? game.houseStakeSats : 0n)
  const builder = contract.functions[name]().from({ ...position.coin, sourceTx: position.sourceTx })
    .to([{ script: contract.pkScript, amount: BigInt(position.coin.value) - payout }, { script: game.playerPayoutPkScript, amount: payout }])
    .withPacket(controlPacket(descriptor))
  for (const packet of poolStatePackets({ ...position.state, phase: 'idle',
    carriedLossSats: position.state.carriedLossSats + (name === 'playerTimeout' ? game.houseStakeSats : 0n) })) builder.withPacket(packet)
  return builder
}

function input(coin: NormalizedExtendedVirtualCoin): ArkTxInput {
  return { txid: coin.txid, vout: coin.vout, value: coin.value, tapLeafScript: coin.forfeitTapLeafScript, tapTree: coin.tapTree }
}

async function ordinary(client: arkade.Arkade, coins: NormalizedExtendedVirtualCoin[], outputs: { script: Uint8Array; amount: bigint }[],
  extra: { type(): number; serialize(): Uint8Array }[] = []): Promise<{ txid: string }> {
  const { identity, arkProvider } = client
  if (!identity || !arkProvider.submitTx || !arkProvider.finalizeTx) throw new Error('Ordinary spend needs a signer and operator')
  const built = buildOffchainTx(coins.map(input), [...outputs, ...(extra.length ? [Extension.create(extra).txOut()] : [])], client.checkpoint)
  const signed = await identity.sign(built.arkTx)
  const submitted = await arkProvider.submitTx(base64.encode(signed.toPSBT()), built.checkpoints.map(tx => base64.encode(tx.toPSBT())))
  const checkpoints = await signCheckpointsByOutpoint(submitted.signedCheckpointTxs, built.checkpoints.map(checkpoint => ({ checkpoint, identity })))
  await arkProvider.finalizeTx(submitted.arkTxid, checkpoints)
  return { txid: submitted.arkTxid }
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
    const entries = Extension.fromBytes(script).getPackets()
    if (!entries.some(entry => entry.type() === packet.type())) throw new Error('Packet to replace is missing')
    tx.updateOutput(index, Extension.create(entries.map(entry => entry.type() === packet.type() ? packet : entry)).txOut())
    return
  }
  throw new Error('Extension is missing')
}

async function refused(built: Built, head: PoolGamePosition, contract: arkade.ArkadeContract, descriptor: PoolGameDescriptor,
  indexer: RestIndexerProvider, identity?: SingleKey): Promise<void> {
  if (identity) {
    const { validUntil, minTTL } = readPoolFreshAuthorization(built)
    const authorized = await authorizePoolFreshSpend(identity, built, { validUntil, minTTL })
    built.arkTx = authorized.arkTx
    built.checkpoints = authorized.checkpoints
  }
  const response = await fetch(`${EMULATOR}/v1/tx`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await prepareSettleForEmulator(built, indexer)), signal: AbortSignal.timeout(30_000) })
  expect(response.status).toBe(500)
  expect(await response.json()).toMatchObject({ code: 13, message: 'internal error' })
  expect((await waitHead(contract, descriptor, indexer)).coin.txid).toBe(head.coin.txid)
}

async function waitCoin(wallet: Wallet, predicate: (coin: NormalizedExtendedVirtualCoin) => boolean): Promise<NormalizedExtendedVirtualCoin> {
  let found: NormalizedExtendedVirtualCoin | undefined
  await waitUntil(async () => { found = (await wallet.getSpendableVtxos()).find(predicate); return !!found })
  return found!
}

async function waitHead(contract: arkade.ArkadeContract, descriptor: PoolGameDescriptor, indexer: RestIndexerProvider, txid?: string): Promise<PoolGamePosition> {
  let found: PoolGamePosition | undefined
  await waitUntil(async () => { found = await readPoolGamePosition(contract, descriptor, indexer); return !!found && (!txid || found.coin.txid === txid) })
  return found!
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 45_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for funded pool state')
    await sleep(250)
  }
}
