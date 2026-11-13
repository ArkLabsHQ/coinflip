import { createHash } from 'crypto'
import { base64, hex } from '@scure/base'
import {
  ArkAddress, CSVMultisigTapscript, DefaultVtxo, EsploraProvider, InMemoryContractRepository,
  InMemoryWalletRepository, RestIndexerProvider, RestOperatorProvider, SingleKey,
  PrevArkTxField, Transaction, Wallet, buildOffchainTx, decodeTapscript, getArkPsbtFields, isVtxoSpent, type ArkTxInput,
} from '@arkade-os/sdk'
import {
  CoinflipJointPotScript, buildPlayerRevealTx, buildStageTwoSettleTx,
  buildStageTwoTakeAllTx, emulator, prepareSettleForEmulator, packets,
  type BuiltJointPotTx, type Outpoint,
} from 'arkade-coinflip'
import { createTestWallet, fundWallet, sleep, waitVtxos } from './helpers'
import { signCheckpointsByOutpoint } from './test-helpers/checkpoint-signers'
import { contractOptions } from './test-helpers/coinflip-fixture'

const ARK = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMULATOR = process.env.EMULATOR_URL || 'http://localhost:7073'
const STAKE = 1000n
const POT = STAKE * 2n
const SPONSOR = 10_000n
const FEE = 300n
const hash = (value: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(value).digest())
const xonly = (value: Uint8Array): Uint8Array => value.length === 33 ? value.slice(1) : value

describe('emulator previous-transaction preparation', () => {
  it('binds original transactions through shuffled checkpoints without changing signed transaction IDs', async () => {
    const identity = SingleKey.fromRandomBytes()
    const options = contractOptions({ playerPubkey: await identity.xOnlyPublicKey() })
    const pot = new CoinflipJointPotScript(options)
    const ordinary = new DefaultVtxo.Script({
      pubKey: options.playerPubkey, serverPubKey: options.serverPubkey,
      csvTimelock: { type: 'seconds', value: options.exitDelay },
    })
    const sources = [pot.pkScript, ordinary.pkScript].map((script, index) => {
      const tx = new Transaction({ version: 3 })
      tx.addInput({ txid: new Uint8Array(32).fill(index + 1), index: 0 })
      tx.addOutput({ script, amount: index === 0 ? 100_000n : SPONSOR })
      return tx
    })
    const checkpointScript = CSVMultisigTapscript.encode({
      pubkeys: [options.serverPubkey], timelock: { type: 'seconds', value: 512n },
    })
    const built = buildOffchainTx([
      { txid: sources[0].id, vout: 0, value: 100_000, tapLeafScript: pot.playerWinCovenant(), tapTree: pot.encode() },
      { txid: sources[1].id, vout: 0, value: Number(SPONSOR), tapLeafScript: ordinary.forfeit(), tapTree: ordinary.encode() },
    ], [{ script: ordinary.pkScript, amount: 100_000n + SPONSOR }], checkpointScript)
    built.arkTx = await identity.sign(built.arkTx, [1])
    built.checkpoints[1] = await identity.sign(built.checkpoints[1], [0])
    const id = built.arkTx.id
    const signatures = built.arkTx.getInput(1).tapScriptSig
    expect(signatures?.length).toBeGreaterThan(0)
    built.checkpoints.reverse()
    const checkpointBytes = built.checkpoints.map(tx => base64.encode(tx.toPSBT()))
    const getVirtualTxs = jest.fn(async (txids: string[]) => {
      expect(txids).toEqual(sources.map(tx => tx.id))
      return { txs: sources.slice().reverse().map(tx => base64.encode(tx.toPSBT())) }
    })
    const body = await prepareSettleForEmulator(built, { getVirtualTxs })
    expect(built.arkTx.id).toBe(id)
    expect(built.arkTx.getInput(1).tapScriptSig).toEqual(signatures)
    expect(body.checkpointTxs).toEqual(checkpointBytes)
    const decoded = Transaction.fromPSBT(base64.decode(body.arkTx))
    expect(decoded.id).toBe(id)
    for (const [index, source] of sources.entries()) {
      expect(getArkPsbtFields(decoded, index, PrevArkTxField)).toEqual([source.toBytes()])
    }
    await prepareSettleForEmulator(built, { getVirtualTxs })
    expect(getVirtualTxs).toHaveBeenCalledTimes(1)
    await expect(prepareSettleForEmulator({ ...built, checkpoints: [] }, { getVirtualTxs })).rejects.toThrow(/exactly one checkpoint/)
  })
})

describe('compiled coinflip covenants on the real emulator', () => {
  const operator = new RestOperatorProvider(ARK)
  const indexer = new RestIndexerProvider(ARK)
  const onchain = new EsploraProvider(ESPLORA)
  const player = SingleKey.fromRandomBytes()
  const house = SingleKey.fromRandomBytes()
  const playerReveal = packets.encodeReveal(0, new Uint8Array(16).fill(0x11))
  const houseReveal = packets.encodeReveal(0, new Uint8Array(16).fill(0x22))
  const wallets: Wallet[] = []
  let wallet: Wallet
  let pot: CoinflipJointPotScript
  let playerPayout: Uint8Array
  let housePayout: Uint8Array
  let serverUnroll: CSVMultisigTapscript.Type
  let coins: Outpoint[]
  let sponsor: ArkTxInput

  beforeAll(async () => {
    const info = await operator.getInfo()
    const response = await fetch(`${EMULATOR}/v1/info`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Required emulator is unavailable: ${response.status}`)
    const emulatorInfo = await response.json() as { signerPubkey: string }
    serverUnroll = decodeTapscript(hex.decode(info.checkpointTapscript)) as CSVMultisigTapscript.Type
    if (!CSVMultisigTapscript.is(serverUnroll)) throw new Error('Operator checkpoint is not CSV multisig')
    wallet = await createTestWallet(player, {
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    })
    wallets.push(wallet)
    const houseWallet = await createTestWallet(house, {
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    })
    wallets.push(houseWallet)
    playerPayout = ArkAddress.decode(await wallet.getAddress()).pkScript
    housePayout = ArkAddress.decode(await houseWallet.getAddress()).pkScript
    const tip = await onchain.getChainTip()
    const now = Math.max(Math.floor(Date.now() / 1000), tip.time)
    pot = new CoinflipJointPotScript({
      playerPubkey: await player.xOnlyPublicKey(), creatorPubkey: await house.xOnlyPublicKey(),
      serverPubkey: xonly(hex.decode(info.signerPubkey)), emulatorPubkey: xonly(hex.decode(emulatorInfo.signerPubkey)),
      playerHash: hash(playerReveal), creatorHash: hash(houseReveal),
      playerPayoutPkScript: playerPayout, housePayoutPkScript: housePayout,
      playerStake: STAKE, houseStake: STAKE, oddsN: 2, oddsLo: 0, oddsTarget: 1,
      cancelDelay: BigInt(now + 1800), finalExpiration: BigInt(now + 3600),
      exitDelay: BigInt(Math.max(512, Math.ceil(Number(info.unilateralExitDelay) / 512) * 512)),
    })
    await fundWallet(wallet, 100_000)
    const funding = (await waitVtxos(wallet)).find(coin => BigInt(coin.value) >= 3n * POT + SPONSOR + 330n)
    if (!funding) throw new Error('Funding wallet has no sufficiently large VTXO')
    const built = buildOffchainTx([{
      txid: funding.txid, vout: funding.vout, value: funding.value,
      tapLeafScript: funding.forfeitTapLeafScript, tapTree: funding.tapTree,
    }], [
      ...Array.from({ length: 3 }, () => ({ script: pot.pkScript, amount: POT })),
      { script: playerPayout, amount: SPONSOR },
      { script: playerPayout, amount: BigInt(funding.value) - 3n * POT - SPONSOR },
    ], serverUnroll)
    const signed = await player.sign(built.arkTx, [0])
    const submitted = await operator.submitTx(base64.encode(signed.toPSBT()), built.checkpoints.map(tx => base64.encode(tx.toPSBT())))
    const finalCheckpoints = await signCheckpointsByOutpoint(submitted.signedCheckpointTxs, [
      { checkpoint: built.checkpoints[0], identity: player },
    ])
    await operator.finalizeTx(submitted.arkTxid, finalCheckpoints)
    coins = Array.from({ length: 3 }, (_, vout) => ({ txid: submitted.arkTxid, vout, value: Number(POT) }))
    for (const coin of coins) await waitOutput(pot.pkScript, coin.txid, coin.vout, POT)
    const deadline = Date.now() + 45_000
    for (;;) {
      const coin = (await wallet.getVtxos()).find(coin => coin.txid === submitted.arkTxid && coin.vout === 3)
      if (coin) {
        sponsor = { txid: coin.txid, vout: coin.vout, value: coin.value, tapLeafScript: coin.forfeitTapLeafScript, tapTree: coin.tapTree }
        break
      }
      if (Date.now() >= deadline) throw new Error('Sponsor VTXO was not indexed')
      await sleep(1000)
    }
  }, 180_000)

  afterAll(async () => {
    await Promise.all(wallets.map(wallet => wallet.dispose()))
  })

  it.each(['wrong payout', 'wrong amount', 'wrong winner', 'forged reveal', 'missing reveal', 'swapped reveals'] as const)(
    'rejects %s inside the actual compiled covenant', async attack => {
      const forged = playerReveal.slice()
      forged[forged.length - 1] ^= 1
      const winner = attack === 'wrong winner' ? 'creatorWin' : 'playerWin'
      const outputs = attack === 'wrong amount'
        ? [{ script: playerPayout, amount: STAKE }, { script: housePayout, amount: STAKE }]
        : [{ script: attack === 'wrong payout' || attack === 'wrong winner' ? housePayout : playerPayout, amount: POT }]
      const built = spend([coins[0]], winner, outputs, {
        player: attack === 'forged reveal' ? forged : attack === 'swapped reveals' ? houseReveal : playerReveal,
        house: attack === 'missing reveal' ? undefined : attack === 'swapped reveals' ? playerReveal : houseReveal,
      })
      await expectCovenantRejection(built)
      await waitOutput(pot.pkScript, coins[0].txid, coins[0].vout, POT)
    },
  )

  it('settles the same unspent pot normally after all rejected theft attempts', async () => {
    const txid = await submit(spend([coins[0]], 'playerWin', [{ script: playerPayout, amount: POT }]))
    await waitOutput(playerPayout, txid, 0, POT)
  })

  it('rejects two pots sharing one payout when the second covenant executes at input one', async () => {
    const built = spend([coins[1], coins[2]], 'playerWin', [
      { script: playerPayout, amount: POT },
      { script: housePayout, amount: POT },
    ])
    await expectCovenantRejection(built)
    await waitOutput(pot.pkScript, coins[1].txid, coins[1].vout, POT)
    await waitOutput(pot.pkScript, coins[2].txid, coins[2].vout, POT)
  })

  it('accepts a signed ordinary input paying a 300-sat fee beside the full input-zero pot payout', async () => {
    const path = pot.functionByName('playerWin')!
    const built = buildOffchainTx([contractInput(coins[1], 'playerWin'), sponsor], [
      { script: playerPayout, amount: POT },
      { script: playerPayout, amount: SPONSOR - FEE },
    ], serverUnroll)
    emulator.addPacket(built.arkTx, [{ vin: 0, script: path.arkadeScript!, witness: emulator.encodeWitness([]) }])
    addReveals(built, { player: playerReveal, house: houseReveal })
    built.arkTx = await player.sign(built.arkTx, [1])
    built.checkpoints[1] = await player.sign(built.checkpoints[1], [0])
    expect(built.arkTx.getOutput(built.arkTx.outputsLength - 1).amount).toBe(FEE)
    const txid = await submit(built)
    await waitOutput(playerPayout, txid, 0, POT)
    await waitOutput(playerPayout, txid, 1, SPONSOR - FEE)
  })

  it('enters the contest with the player reveal and refuses its premature timeout', async () => {
    const reveal = buildPlayerRevealTx({ pot, cofund: coins[2], playerRevealBytes: playerReveal, serverUnroll })
    reveal.arkTx = await player.sign(reveal.arkTx, [0])
    reveal.checkpoints[0] = await player.sign(reveal.checkpoints[0], [0])
    const revealedTxid = await submit(reveal)
    await waitOutput(pot.stageTwo.pkScript, revealedTxid, 0, POT)
    const outpoint = { txid: revealedTxid, vout: 0, value: Number(POT) }
    const timeout = buildStageTwoTakeAllTx({
      stageTwo: pot.stageTwo, stageTwoOutpoint: outpoint,
      playerPayoutPkScript: playerPayout, potAmount: POT, serverUnroll,
    })
    expect(timeout.arkTx.lockTime).toBe(Number(pot.options.finalExpiration))
    expect(timeout.checkpoints[0].lockTime).toBe(Number(pot.options.finalExpiration))
    timeout.arkTx = await player.sign(timeout.arkTx, [0])
    timeout.checkpoints[0] = await player.sign(timeout.checkpoints[0], [0])
    const rejection = await post(timeout)
    expect(rejection.status).toBeGreaterThanOrEqual(400)
    expect(rejection.status).toBeLessThan(600)
    await waitOutput(pot.stageTwo.pkScript, revealedTxid, 0, POT)
    const settled = await submit(buildStageTwoSettleTx({
      stageTwo: pot.stageTwo, stageTwoOutpoint: outpoint, winner: 'player',
      winnerPayoutPkScript: playerPayout, potAmount: POT,
      playerRevealBytes: playerReveal, creatorRevealBytes: houseReveal, serverUnroll,
    }))
    await waitOutput(playerPayout, settled, 0, POT)
  })

  function contractInput(coin: Outpoint, name: 'playerWin' | 'creatorWin'): ArkTxInput {
    return { ...coin, tapLeafScript: pot.functionByName(name)!.tapLeafScript, tapTree: pot.encode() }
  }

  function addReveals(built: BuiltJointPotTx, reveal: { player?: Uint8Array; house?: Uint8Array }): void {
    if (reveal.player) packets.addRevealPacket(built.arkTx, packets.REVEAL_PLAYER_PACKET_TYPE, reveal.player)
    if (reveal.house) packets.addRevealPacket(built.arkTx, packets.REVEAL_CREATOR_PACKET_TYPE, reveal.house)
  }

  function spend(
    inputs: Outpoint[], name: 'playerWin' | 'creatorWin',
    outputs: { script: Uint8Array; amount: bigint }[],
    reveals = { player: playerReveal, house: houseReveal } as { player?: Uint8Array; house?: Uint8Array },
  ): BuiltJointPotTx {
    const built = buildOffchainTx(inputs.map(coin => contractInput(coin, name)), outputs, serverUnroll)
    emulator.addPacket(built.arkTx, inputs.map((_, vin) => ({
      vin, script: pot.functionByName(name)!.arkadeScript!, witness: emulator.encodeWitness([]),
    })))
    addReveals(built, reveals)
    return built
  }

  async function post(built: BuiltJointPotTx): Promise<{ status: number; body: string }> {
    const body = JSON.stringify(await prepareSettleForEmulator(built, indexer, onchain))
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${EMULATOR}/v1/tx`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(30_000),
      })
      const text = await response.text()
      if (response.status >= 500 && /VTXO_NOT_FOUND|(?:vtxo|transaction).*not found|not found.*(?:vtxo|transaction)/i.test(text) && attempt < 8) {
        await sleep(500 + attempt * 250)
        continue
      }
      return { status: response.status, body: text }
    }
  }

  async function expectCovenantRejection(built: BuiltJointPotTx): Promise<void> {
    const result = await post(built)
    // Emulator 0.0.9 hides VM failures behind code 13; unchanged coins and subsequent valid spends are the controls.
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(result.status).toBeLessThan(600)
  }

  async function submit(built: BuiltJointPotTx): Promise<string> {
    const result = await post(built)
    if (result.status < 200 || result.status >= 300) throw new Error(`Emulator rejected valid spend: ${result.status} ${result.body}`)
    const body = JSON.parse(result.body) as { signedArkTx: string }
    if (!body.signedArkTx) throw new Error(`Emulator returned no signed transaction: ${result.body}`)
    return Transaction.fromPSBT(base64.decode(body.signedArkTx)).id
  }

  async function waitOutput(script: Uint8Array, txid: string, vout: number, value: bigint): Promise<void> {
    const deadline = Date.now() + 45_000
    for (;;) {
      const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(script)] })
      if (vtxos.some(coin => coin.txid === txid && coin.vout === vout && BigInt(coin.value) === value && !isVtxoSpent(coin))) return
      if (Date.now() >= deadline) throw new Error(`Unspent output ${txid}:${vout} (${value} sats) was not indexed`)
      await sleep(750)
    }
  }
})
