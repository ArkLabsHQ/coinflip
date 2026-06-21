/**
 * v4 SCALE HARNESS — many clients, hundreds of games, per-phase timing.
 *
 * Reuses the proven joint-pot game (co-fund + settle). Provisions WALLETS client
 * identities (each pre-split into GAMES_PER_WALLET stake VTXOs) + a house pool
 * (TOTAL stake VTXOs), then runs TOTAL games with a concurrency cap, measuring
 * per-phase latency (co-fund, settle) + throughput + failure modes.
 *
 *   LOAD_WALLETS × LOAD_GAMES games, peak concurrency LOAD_CONC.
 */
import { base64, hex } from '@scure/base'
import { createHash } from 'crypto'
import { CoinflipJointPotScript, determineWinnerV3 } from 'arkade-coinflip'
import {
  Wallet, SingleKey, RestArkProvider, RestIndexerProvider, InMemoryWalletRepository,
  InMemoryContractRepository, decodeTapscript, buildOffchainTx, CSVMultisigTapscript,
  Transaction, ArkAddress, type ArkInfo, type ArkProvider, type ArkTxInput, type Identity,
} from '@arkade-os/sdk'
import { emulator, packets } from '@arklabshq/contract-workflows-prototype'
import { faucet } from './helpers'

const ARK = process.env.ARK_SERVER_URL || 'http://localhost:7070'
const ESPLORA = process.env.ESPLORA_URL || 'http://localhost:3000/api'
const EMU = process.env.EMULATOR_URL || 'http://localhost:7073'
const HRP = 'rark'
const BET = 1000
const PER_VTXO = 5000 // stake + change headroom (change stays above dust)
const WALLETS = Number(process.env.LOAD_WALLETS || 3)
const GAMES_PER_WALLET = Number(process.env.LOAD_GAMES || 2)
const CONC = Number(process.env.LOAD_CONC || 6)
const TOTAL = WALLETS * GAMES_PER_WALLET

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest())
const toXOnly = (p: Uint8Array) => (p.length === 33 ? p.slice(1) : p)
const pct = (xs: number[], p: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0

type Vtxo = { txid: string; vout: number; value: number; forfeitTapLeafScript: unknown; tapTree: Uint8Array }
const toInput = (v: Vtxo): ArkTxInput => ({ txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: v.forfeitTapLeafScript as ArkTxInput['tapLeafScript'], tapTree: v.tapTree })

// Serialize arkd offchain submits. Independent client-side submits race arkd's
// round assembly → a spurious INVALID_SIGNATURE that STILL consumes the input
// (so it's not safely retryable). The v4 design funnels all submits through the
// API, so serializing this one boundary models the real architecture; the rest
// of the pipeline (build, sign, emulator settle, verify) stays fully concurrent.
let arkLock: Promise<unknown> = Promise.resolve()
function withArkLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = arkLock.then(fn, fn)
  arkLock = run.catch(() => undefined)
  return run
}

describe('v4 scale: many concurrent joint-pot games', () => {
  let ok = false
  let ark: ArkProvider
  let indexer: RestIndexerProvider
  let info: ArkInfo
  let unroll: CSVMultisigTapscript.Type
  let emuPub: Uint8Array
  let serverPub: Uint8Array

  beforeAll(async () => {
    try {
      ark = new RestArkProvider(ARK); indexer = new RestIndexerProvider(ARK)
      info = await ark.getInfo()
      unroll = decodeTapscript(hex.decode(info.checkpointTapscript)) as CSVMultisigTapscript.Type
      emuPub = hex.decode((await (await fetch(`${EMU}/v1/info`)).json() as { signerPubkey: string }).signerPubkey)
      serverPub = toXOnly(hex.decode(info.signerPubkey))
      ok = !!info?.signerPubkey
    } catch { ok = false }
  }, 25_000)

  async function makeWallet(id: SingleKey): Promise<Wallet> {
    return Wallet.create({
      identity: id, arkServerUrl: ARK, esploraUrl: ESPLORA,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
  }
  async function waitSettled(w: Wallet, min: number, t = 120_000) {
    const s = Date.now()
    while (Date.now() - s < t) { if ((await w.getBalance()).settled >= min) return; await sleep(2000) }
    throw new Error('settle timeout')
  }
  async function waitBoarding(w: Wallet, min: number, t = 120_000) {
    const s = Date.now()
    while (Date.now() - s < t) { if ((await w.getBalance()).boarding.total >= min) return; await sleep(2000) }
    throw new Error('boarding timeout')
  }
  async function settleRetry(w: Wallet, tries = 4) {
    for (let i = 0; i < tries; i++) {
      try { await w.settle(); return } catch (e) {
        if (!String(e).includes('No inputs found') || i === tries - 1) throw e
        await sleep(5000)
      }
    }
  }
  // Each party signs its own input + checkpoint; arkd cosigns. Submits one tx.
  async function submitMultisig(arkTx: Transaction, checkpoints: Transaction[], signers: { id: Identity; vin: number }[]): Promise<string> {
    let s = arkTx
    for (const sg of signers) s = await sg.id.sign(s, [sg.vin])
    const { arkTxid, signedCheckpointTxs } = await ark.submitTx(base64.encode(s.toPSBT()), checkpoints.map((c) => base64.encode(c.toPSBT())))
    const finals: string[] = []
    for (let i = 0; i < signedCheckpointTxs.length; i++) {
      const tx = Transaction.fromPSBT(base64.decode(signedCheckpointTxs[i]))
      const owner = signers.find((sg) => sg.vin === i)?.id ?? signers[0].id
      let f = tx
      try { f = await owner.sign(tx, Array.from({ length: tx.inputsLength }, (_, k) => k)) } catch (e) { if (!String(e).includes('No taproot scripts signed')) throw e }
      finals.push(base64.encode(f.toPSBT()))
    }
    await ark.finalizeTx(arkTxid, finals)
    return arkTxid
  }
  // Fund + split a wallet into n VTXOs of PER_VTXO sats each.
  async function provision(id: SingleKey, n: number): Promise<{ vtxos: Vtxo[]; payoutPk: Uint8Array }> {
    const w = await makeWallet(id)
    const need = n * PER_VTXO + 5000
    await faucet(await w.getBoardingAddress(), need / 1e8 + 0.0001)
    await waitBoarding(w, n * PER_VTXO)
    await settleRetry(w)
    await waitSettled(w, n * PER_VTXO)
    const big = (await w.getVtxos())[0]
    const selfPk = ArkAddress.decode(await w.getAddress()).pkScript
    const outs = Array.from({ length: n }, () => ({ script: selfPk, amount: BigInt(PER_VTXO) }))
    const change = big.value - n * PER_VTXO
    if (change > 330) outs.push({ script: selfPk, amount: BigInt(change) })
    const { arkTx, checkpoints } = buildOffchainTx([toInput(big as unknown as Vtxo)], outs, unroll)
    const txid = await submitMultisig(arkTx, checkpoints, [{ id, vin: 0 }])
    // Re-fetch via the WALLET (enriches each VTXO with forfeitTapLeafScript +
    // tapTree, which the raw indexer response omits — buildOffchainTx needs them).
    for (let i = 0; i < 30; i++) {
      const all = await w.getVtxos()
      const stakes = all.filter((v) => v.txid === txid && v.value === PER_VTXO)
      if (stakes.length >= n) return { vtxos: stakes.slice(0, n) as unknown as Vtxo[], payoutPk: selfPk }
      await sleep(1000)
    }
    throw new Error('split VTXOs did not appear')
  }

  // One full v4 game; returns per-phase timings (ms). Payout pkScripts precomputed.
  async function playGameInner(playerId: SingleKey, playerPub: Uint8Array, ppk: Uint8Array, pv: Vtxo, houseId: SingleKey, housePub: Uint8Array, hpk: Uint8Array, hv: Vtxo) {
    const saltP = crypto.getRandomValues(new Uint8Array(16)), saltC = crypto.getRandomValues(new Uint8Array(16))
    const pReveal = packets.encodeReveal(0, saltP), cReveal = packets.encodeReveal(0, saltC)
    const winner = determineWinnerV3({ digit: 0, salt: saltC }, { digit: 0, salt: saltP }, 2, 1, 0)
    const potS = new CoinflipJointPotScript({
      creatorPubkey: housePub, playerPubkey: playerPub, serverPubkey: serverPub,
      creatorHash: sha(cReveal), playerHash: sha(pReveal), finalExpiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
      exitDelay: 86_528n, oddsN: 2, oddsTarget: 1, oddsLo: 0, emulatorPubkey: emuPub,
      playerPayoutPkScript: ppk, housePayoutPkScript: hpk, playerStake: BigInt(BET), houseStake: BigInt(BET),
    })
    const potAddr = potS.address(HRP, serverPub).pkScript

    const t0 = Date.now()
    const cofundOuts = [
      { script: potAddr, amount: BigInt(2 * BET) },
      { script: ppk, amount: BigInt(pv.value - BET) },
      { script: hpk, amount: BigInt(hv.value - BET) },
    ]
    const cf = buildOffchainTx([toInput(pv), toInput(hv)], cofundOuts, unroll)
    const cofundTxid = await withArkLock(() => submitMultisig(cf.arkTx, cf.checkpoints, [{ id: playerId, vin: 0 }, { id: houseId, vin: 1 }]))
    const cofundMs = Date.now() - t0

    const t1 = Date.now()
    const leaf = winner === 'player' ? potS.playerWinCovenant() : potS.creatorWinCovenant()
    const arkadeScript = winner === 'player' ? potS.playerWinFullArkadeScript : potS.creatorWinFullArkadeScript
    const winPk = winner === 'player' ? ppk : hpk
    const settle = buildOffchainTx([{ txid: cofundTxid, vout: 0, value: 2 * BET, tapLeafScript: leaf, tapTree: potS.encode() }], [{ script: winPk, amount: BigInt(2 * BET) }], unroll)
    const cp = settle.checkpoints[0], cpIn = cp.getInput(0)
    if (cpIn?.witnessUtxo) cp.updateInput(0, { witnessUtxo: { script: potS.pkScript, amount: cpIn.witnessUtxo.amount } })
    emulator.addPacket(settle.arkTx, [{ vin: 0, script: arkadeScript, witness: emulator.encodeWitness([emulator.encodeIndex(0)]) }])
    packets.addRevealPacket(settle.arkTx, packets.REVEAL_PLAYER_PACKET_TYPE, pReveal)
    packets.addRevealPacket(settle.arkTx, packets.REVEAL_CREATOR_PACKET_TYPE, cReveal)
    const body = JSON.stringify({ arkTx: base64.encode(settle.arkTx.toPSBT()), checkpointTxs: settle.checkpoints.map((c) => base64.encode(c.toPSBT())) })
    // The emulator forwards the settle to arkd, so each POST is an arkd submit —
    // serialize it under the same lock (backoff happens outside the lock).
    const postOnce = async (): Promise<{ ok: true; txid: string } | { ok: false; status: number; text: string }> => {
      const r = await fetch(`${EMU}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) })
      if (r.ok) return { ok: true, txid: Transaction.fromPSBT(base64.decode((await r.json() as { signedArkTx: string }).signedArkTx)).id }
      return { ok: false, status: r.status, text: await r.text() }
    }
    let settleTxid = ''
    for (let a = 0; a < 12; a++) {
      const res = await withArkLock(postOnce)
      if (res.ok) { settleTxid = res.txid; break }
      if (!(res.status >= 500 && /not found|VTXO_NOT_FOUND|failed to process/i.test(res.text)) || a === 11) throw new Error(`settle: ${res.status} ${res.text}`)
      await sleep(500 + a * 500)
    }
    const settleMs = Date.now() - t1
    // r.ok ⇒ the emulator cosigned AND forwarded the finalized settle to arkd
    // (arkd accepted it). Real on-chain landing is sample-verified after the run.
    return { cofundMs, settleMs, settleTxid, winPkHex: hex.encode(winPk) }
  }

  it(`runs ${TOTAL} games (${WALLETS} clients × ${GAMES_PER_WALLET}, conc ${CONC}) and reports per-phase timing`, async () => {
    if (!ok) { console.warn('ark/emu unavailable — skipped'); return }
    console.log(`[scale] provisioning ${WALLETS} clients × ${GAMES_PER_WALLET} stake VTXOs + house pool of ${TOTAL}…`)
    const houseId = SingleKey.fromRandomBytes()
    const housePub = await houseId.xOnlyPublicKey()
    const [houseProv, ...playerSets] = await Promise.all([
      provision(houseId, TOTAL),
      ...Array.from({ length: WALLETS }, async () => {
        const id = SingleKey.fromRandomBytes()
        const prov = await provision(id, GAMES_PER_WALLET)
        return { id, pub: await id.xOnlyPublicKey(), vtxos: prov.vtxos, payoutPk: prov.payoutPk }
      }),
    ]) as [{ vtxos: Vtxo[]; payoutPk: Uint8Array }, ...{ id: SingleKey; pub: Uint8Array; vtxos: Vtxo[]; payoutPk: Uint8Array }[]]
    const houseVtxos = houseProv.vtxos, housePk = houseProv.payoutPk

    const jobs: { p: typeof playerSets[number]; pv: Vtxo; hv: Vtxo }[] = []
    let hi = 0
    for (const p of playerSets) for (const pv of p.vtxos) jobs.push({ p, pv, hv: houseVtxos[hi++] })

    const cofunds: number[] = [], settles: number[] = [], totals: number[] = []
    const settled: { txid: string; pk: string }[] = []
    let done = 0, failed = 0
    const failModes = new Map<string, number>()
    const start = Date.now()
    let next = 0
    async function worker() {
      while (next < jobs.length) {
        const j = jobs[next++]
        try {
          const t = await playGameInner(j.p.id, j.p.pub, j.p.payoutPk, j.pv, houseId, housePub, housePk, j.hv)
          cofunds.push(t.cofundMs); settles.push(t.settleMs); totals.push(t.cofundMs + t.settleMs); done++
          settled.push({ txid: t.settleTxid, pk: t.winPkHex })
        } catch (e) {
          failed++
          const m = String(e instanceof Error ? e.message : e).slice(0, 60)
          failModes.set(m, (failModes.get(m) || 0) + 1)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker))
    const wallMs = Date.now() - start

    // Sample-verify real on-chain landing: pick up to 10 settled games, confirm
    // each winner's pot VTXO is indexed. Proves r.ok actually settled (not just
    // "accepted"), without per-game indexer contention during the run.
    const sample = settled.filter((s) => s.txid).slice(0, 10)
    let verified = 0
    for (const s of sample) {
      for (let v = 0; v < 20; v++) {
        const { vtxos } = await indexer.getVtxos({ scripts: [s.pk] })
        if (vtxos.some((x) => x.txid === s.txid && x.value === 2 * BET)) { verified++; break }
        await sleep(1000)
      }
    }

    console.log('\n========== v4 SCALE RESULTS ==========')
    console.log(`games: ${done}/${TOTAL} settled, ${failed} failed`)
    console.log(`sample-verified on-chain: ${verified}/${sample.length}`)
    console.log(`wall time: ${(wallMs / 1000).toFixed(1)}s  → throughput ${(done / (wallMs / 60000)).toFixed(1)} games/min`)
    console.log(`co-fund ms: p50 ${pct(cofunds, 50)}  p95 ${pct(cofunds, 95)}`)
    console.log(`settle  ms: p50 ${pct(settles, 50)}  p95 ${pct(settles, 95)}`)
    console.log(`total   ms: p50 ${pct(totals, 50)}  p95 ${pct(totals, 95)}`)
    if (failModes.size) { console.log('failure modes:'); for (const [m, c] of failModes) console.log(`  ${c}× ${m}`) }
    console.log('======================================\n')

    expect(done).toBeGreaterThan(0)
    expect(verified).toBe(sample.length) // every sampled settle really landed on-chain
  }, 1_800_000)
})
