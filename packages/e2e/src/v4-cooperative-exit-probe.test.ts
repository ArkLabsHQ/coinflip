import { signCheckpointsByOutpoint } from './test-helpers/checkpoint-signers'
import { createTestWallet } from './helpers'
/**
 * v4 cooperative on-chain EXIT probe (leaf 7) — end-to-end regtest proof that a
 * stalled joint pot can be exited on-chain with both funders' signatures when
 * the emulator/arkd offchain path is unavailable. Validates the PRODUCTION builder
 * `buildCooperativeSpendExitTx`.
 *
 * Flow: co-fund a real pot (offchain) → SDK `Unroll.Session` lands it on-chain
 * (funded `OnchainWallet` bumper CPFPs the anchors; background miner confirms the
 * 1C1P packages) → advance the MTP past the exit CSV ({value: exitDelay, type:
 * 'seconds'} ≈ 24h) → spend `pot.cooperativeSpendExit()` (leaf 7, CSVMultisig
 * [player, creator], no emulator), signed player+creator → assert it confirms.
 *
 * CLOCK-SENSITIVE: advances the regtest MTP ~24h irreversibly, so it runs ISOLATED
 * on its own fresh stack (a separate CI matrix job; see e2e.yml). Leaves 4/6
 * (emulator-tweaked exits) are a separate Phase-2 probe.
 */
import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import {
  CoinflipJointPotScript,
  buildJointPotCofundTx, jointPotCofundOutputs, buildCooperativeSpendExitTx,
} from 'arkade-coinflip'
import {
  Wallet, SingleKey, RestOperatorProvider, RestIndexerProvider, EsploraProvider, OnchainWallet,
  InMemoryWalletRepository, InMemoryContractRepository, decodeTapscript, buildOffchainTx,
  CSVMultisigTapscript, Transaction, ArkAddress, Unroll,
  type OperatorInfo, type OperatorProvider, type ArkTxInput, type Identity,
} from '@arkade-os/sdk'
import { packets } from 'arkade-coinflip'
import { faucet, waitVtxos, mineBlock, setChainTime, resetChainTime } from './helpers'

const ARK = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMU = process.env.EMULATOR_URL || 'http://localhost:7073'
const HRP = 'rark'
const BET = 1000
const PER_VTXO = 5000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
const toXOnly = (p: Uint8Array) => (p.length === 33 ? p.slice(1) : p)
const log = (m: string) => process.stdout.write(`[exit-spike] ${m}\n`)

type Vtxo = { txid: string; vout: number; value: number; forfeitTapLeafScript: unknown; tapTree: Uint8Array }
const toInput = (v: Vtxo): ArkTxInput => ({ txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript as ArkTxInput['tapLeafScript'], tapTree: v.tapTree })

// Advancing MTP by ~24h requires a fresh isolated chain. CI runs this file alone.
const RUN = !!process.env.EXIT_PROBE
;(RUN ? describe : describe.skip)('v4 cooperative on-chain exit (leaf 7)', () => {
  let ok = false
  let ark: OperatorProvider
  let indexer: RestIndexerProvider
  let explorer: EsploraProvider
  let info: OperatorInfo
  let unroll: CSVMultisigTapscript.Type
  let emuPub: Uint8Array
  let serverPub: Uint8Array

  beforeAll(async () => {
    try {
      ark = new RestOperatorProvider(ARK)
      indexer = new RestIndexerProvider(ARK)
      explorer = new EsploraProvider(ESPLORA)
      info = await ark.getInfo()
      unroll = decodeTapscript(hex.decode(info.checkpointTapscript)) as CSVMultisigTapscript.Type
      emuPub = toXOnly(hex.decode((await (await fetch(`${EMU}/v1/info`)).json() as { signerPubkey: string }).signerPubkey))
      serverPub = toXOnly(hex.decode(info.signerPubkey))
      ok = !!info?.signerPubkey
    } catch { ok = false }
    if (!ok) throw new Error('Required regtest services are unavailable')
  }, 30_000)

  afterAll(() => resetChainTime())

  async function makeWallet(id: SingleKey): Promise<Wallet> {
    return createTestWallet(id, {
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
  }
  async function waitBoarding(w: Wallet, min: number, t = 120_000) {
    const s = Date.now()
    while (Date.now() - s < t) { if ((await w.getBalance()).boarding.total >= min) return; await sleep(2000) }
    throw new Error('boarding timeout')
  }
  async function waitSettled(w: Wallet, min: number, t = 120_000) {
    const s = Date.now()
    while (Date.now() - s < t) { if ((await w.getBalance()).settled >= min) return; await sleep(2000) }
    throw new Error('settle timeout')
  }
  async function settleRetry(w: Wallet, tries = 4) {
    for (let i = 0; i < tries; i++) {
      try { await w.settle(); return } catch (e) { if (!String(e).includes('No inputs found') || i === tries - 1) throw e; await sleep(5000) }
    }
  }
  // player + house each sign their own input + checkpoint; arkd cosigns. (v4-scale)
  async function submitMultisig(arkTx: Transaction, checkpoints: Transaction[], signers: { id: Identity; vin: number }[]): Promise<string> {
    let s = arkTx
    for (const sg of signers) s = await sg.id.sign(s, [sg.vin])
    const { arkTxid, signedCheckpointTxs } = await ark.submitTx(base64.encode(s.toPSBT()), checkpoints.map((c) => base64.encode(c.toPSBT())))
    const finals = await signCheckpointsByOutpoint(signedCheckpointTxs,
      checkpoints.map((checkpoint, vin) => {
        const identity = signers.find((signer) => signer.vin === vin)?.id
        if (!identity) throw new Error(`Missing checkpoint owner for input ${vin}`)
        return { checkpoint, identity }
      }),
    )
    await ark.finalizeTx(arkTxid, finals)
    return arkTxid
  }

  // Fund a wallet + leave it with one PER_VTXO stake VTXO. (minimal provision)
  async function provisionOne(id: SingleKey): Promise<{ w: Wallet; stake: Vtxo; payoutPk: Uint8Array }> {
    const w = await makeWallet(id)
    await faucet(await w.getBoardingAddress(), +(((PER_VTXO + 15000) / 1e8)).toFixed(8))
    await waitBoarding(w, PER_VTXO)
    await settleRetry(w)
    await waitSettled(w, PER_VTXO)
    const stake = (await waitVtxos(w)).sort((a, b) => b.value - a.value)[0] as unknown as Vtxo
    return { w, stake, payoutPk: ArkAddress.decode(await w.getAddress()).pkScript }
  }

  it('unrolls a funded pot and spends cooperativeSpendExit (leaf 7) on-chain', async () => {
    if (!ok) throw new Error('Required regtest services are unavailable')

    // ── 1. Co-fund a real joint pot (NOT settled — left funded for the exit) ──
    const playerId = SingleKey.fromRandomBytes(), houseId = SingleKey.fromRandomBytes()
    const P = await provisionOne(playerId), H = await provisionOne(houseId)
    const playerPub = toXOnly(await playerId.xOnlyPublicKey()), housePub = toXOnly(await houseId.xOnlyPublicKey())
    const saltP = crypto.getRandomValues(new Uint8Array(16)), saltC = crypto.getRandomValues(new Uint8Array(16))
    const pReveal = packets.encodeReveal(0, saltP), cReveal = packets.encodeReveal(0, saltC)

    const pot = new CoinflipJointPotScript({
      creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey: serverPub,
      creatorHash: sha(cReveal), playerHash: sha(pReveal),
      finalExpiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
      cancelDelay: BigInt(Math.floor(Date.now() / 1000) + 1800),
      exitDelay: 86_528n, oddsN: 2, oddsTarget: 1, oddsLo: 0, emulatorPubkey: emuPub,
      playerPayoutPkScript: P.payoutPk, housePayoutPkScript: H.payoutPk,
      playerStake: BigInt(BET), houseStake: BigInt(BET),
    })
    const potAddr = pot.address(HRP, serverPub).pkScript
    const cofundOuts = jointPotCofundOutputs({
      potPkScript: potAddr, potAmount: BigInt(2 * BET),
      playerChangePkScript: P.payoutPk, playerChange: BigInt(P.stake.value - BET),
      houseChangePkScript: H.payoutPk, houseChange: BigInt(H.stake.value - BET),
    })
    const cf = buildJointPotCofundTx([toInput(P.stake)], [toInput(H.stake)], cofundOuts, unroll)
    const cofundTxid = await submitMultisig(cf.arkTx, cf.checkpoints, [{ id: playerId, vin: 0 }, { id: houseId, vin: 1 }])
    const potOutpoint = { txid: cofundTxid, vout: 0, value: 2 * BET }
    log(`Q0 pot co-funded (offchain): ${cofundTxid}:0 = ${2 * BET} sats @ ${hex.encode(potAddr)}`)

    // ── 2. SPIKE: unroll the pot VTXO on-chain via Unroll.Session ──
    // Session.create loads the chain via indexer.getVtxoChain(outpoint). First
    // WAIT for the co-fund VTXO to be indexed (the earlier 500 was likely
    // "not indexed yet") — same pattern as v4-scale's waitForArkVtxo.
    const op = { txid: cofundTxid, vout: 0 }
    let indexed = false
    for (let i = 0; i < 30; i++) {
      try {
        const { vtxos } = await indexer.getVtxos({ outpoints: [op] })
        if (vtxos.some((v) => v.txid === cofundTxid && v.vout === 0)) { indexed = true; break }
      } catch { /* transient */ }
      await sleep(1000)
    }
    expect(indexed).toBe(true)
    log(`Q1a pot VTXO indexed: ${indexed}`)
    // Probe getVtxoChain directly to see the raw chain (or the raw error).
    try {
      const chain = await indexer.getVtxoChain(op)
      log(`Q1b getVtxoChain OK: ${JSON.stringify(chain).slice(0, 400)}`)
    } catch (e) {
      log(`Q1b getVtxoChain FAILED: ${e instanceof Error ? e.message : e}`)
    }
    // The bumper is an OnchainWallet (implements AnchorBumper.bumpP2A) — it CPFPs
    // the unroll anchors, so it needs MAINCHAIN sats. Fund its on-chain P2TR addr.
    const bumper = await OnchainWallet.create(playerId, 'regtest', explorer)
    log(`Q1c bumper onchain addr: ${bumper.address}`)
    await faucet(bumper.address, 0.002)
    await sleep(3000) // let the faucet utxo land + index
    // Unroll.Session.create → async iterator of UNROLL (broadcast 1C1P) / WAIT / DONE.
    // WAIT steps block on confirmation, so mine in the background throughout.
    const miner = setInterval(() => { mineBlock(1).catch(() => {}) }, 3000)
    try {
      const session = await Unroll.Session.create(op, bumper, explorer, indexer)
      for await (const step of session) {
        const txid = step.type === Unroll.StepType.UNROLL ? step.tx.id
          : step.type === Unroll.StepType.WAIT ? step.txid : step.vtxoTxid
        log(`Q1 unroll step: ${step.type} ${txid}`)
      }
      log('Q1 RESULT: unroll iterator completed — pot should now be an on-chain UTXO. Confirm via esplora.')
    } finally {
      clearInterval(miner)
    }

    // ── 3. Q2: spend leaf 7 (cooperativeSpendExit) on-chain after the CSV ──
    // Exit CSV = { value: exitDelay (86528s ≈ 24h), type: 'seconds' } — MTP-relative
    // to the pot UTXO's on-chain confirmation. Advance the MTP past it, then spend.
    const potStatus = await explorer.getTxStatus(cofundTxid)
    expect(potStatus.confirmed).toBe(true)
    log(`Q2a pot on-chain status: ${JSON.stringify(potStatus)}`)

    const exitDelay = pot.options.exitDelay
    await setChainTime(Math.floor(Date.now() / 1000) + Number(exitDelay) + 7200, 16)

    // Build the split-back via the PRODUCTION lib builder (this probe validates it).
    const { tx } = buildCooperativeSpendExitTx({
      pot, potOnchain: { txid: cofundTxid, vout: 0, value: 2 * BET },
      playerStake: BigInt(BET), houseStake: BigInt(BET),
      playerPayoutPkScript: P.payoutPk, housePayoutPkScript: H.payoutPk,
      exitDelay, feeSats: 500n,
    })
    log(`Q2b exit CSV sequence=0x${(tx.getInput(0).sequence ?? 0).toString(16)}`)
    let signed = await playerId.sign(tx, [0])
    signed = await houseId.sign(signed, [0])
    signed.finalize()
    const exitTxid = await explorer.broadcastTransaction(signed.hex)
    log(`Q2 RESULT: leaf-7 cooperativeSpendExit SPENT on-chain → ${exitTxid} ✅`)
    // Assert the split-back confirms on-chain (the real gate — no swallowing).
    // Poll: esplora indexes the mined block a beat after mineBlock returns.
    let confirmed = false
    for (let i = 0; i < 20 && !confirmed; i++) {
      await mineBlock(1)
      const st = await explorer.getTxStatus(exitTxid)
      if (st.confirmed) { confirmed = true; log(`Q2c exit tx confirmed: ${JSON.stringify(st)}`); break }
      await sleep(1500)
    }
    expect(exitTxid).toMatch(/^[0-9a-f]{64}$/)
    expect(confirmed).toBe(true)
    log('Q3 (Phase 2, separate): leaves 4/6 need the emulator to co-sign an on-chain CSV spend — untested here.')
  }, 900_000)
})
