import 'fake-indexeddb/auto'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { CSVMultisigTapscript, decodeTapscript, Transaction, type IndexerProvider, type VirtualCoin } from '@arkade-os/sdk'
import { base64 } from '@scure/base'
import {
  buildV4SelfRefund,
  pickV4ClaimPath,
  rearmV4ReclaimHint,
  rebuildJointPot,
  isAlreadySpentError,
  isTransientSelfRefundError,
} from './v4SelfRefund'
import type { StashedV4Forfeit } from './v4ForfeitStash'
import type { V4CovenantParams, V4ReclaimHint } from '@/services/api'
import type { V4PlayResponse } from '@/services/api'
import { validatePlay } from './validatePlay'
import { reconcileRecovery } from './recoveryStatus'
import { loadV4Forfeits, putV4Forfeit, saveV4Forfeits } from './v4ForfeitStashStore'

// Deterministic, self-consistent fixtures — no SDK wallet / network. The self-refund
// is the covenant-only `cooperativeSpend` split-back; these tests prove (1) it builds
// a real tx from a known covenant, (2) the secret/no-secret branch picks the right
// path, and (3) the restore re-arm gates fail closed. Fixture pattern (real x-only
// pubkeys + 34-byte p2tr scripts) mirrors packages/e2e joint-pot.unit.test.ts so
// CoinflipJointPotScript accepts the bytes.

const hexstr = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const xonlyBytes = (seed: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(seed))
const xonly = (seed: number): string => hexstr(xonlyBytes(seed))
const h = (seed: number): string => hexstr(new Uint8Array(32).fill(seed))
// p2tr scriptPubKey: OP_1 (0x51) <32-byte push (0x20)> <x-only key>. The key must be
// a real curve point (a payout output gets parsed by OutScript when the refund tx is
// built), so derive it from a schnorr pubkey — a raw fill() is rejected.
const p2tr = (seed: number): string => hexstr(new Uint8Array([0x51, 0x20, ...xonlyBytes(seed)]))

const PLAYER_PAYOUT = p2tr(0x10)

const covenant = (over: Partial<V4CovenantParams> = {}): V4CovenantParams => ({
  creatorPubkey: xonly(1),
  playerPubkey: xonly(2),
  serverPubkey: xonly(3),
  creatorHash: h(0xaa),
  playerHash: h(0xbb),
  finalExpiration: 1_900_000_000,
  cancelDelay: 1_800_000_000,
  exitDelay: 86_528,
  oddsN: 2,
  oddsTarget: 1,
  oddsLo: 0,
  emulatorPubkey: xonly(4),
  playerPayoutPkScript: PLAYER_PAYOUT,
  housePayoutPkScript: p2tr(0x20),
  playerStake: 1000,
  houseStake: 1000,
  ...over,
})

// pot value MUST equal playerStake + houseStake (buildJointPotRefundTx asserts it).
const potOutpoint = { txid: '11'.repeat(32), vout: 0, value: 2000 }

// A real serverUnroll (the checkpoint CSV tapscript): encode a CSV script, then
// decode it back the same way production does (decodeTapscript(arkInfo.checkpointTapscript)).
// decodeTapscript yields the { type, params, script } object buildOffchainTx needs;
// encode().type is just the type-name string, not the tapscript itself.
const serverUnroll = decodeTapscript(
  CSVMultisigTapscript.encode({
    timelock: { value: 144n, type: 'blocks' },
    pubkeys: [new Uint8Array(32).fill(3), new Uint8Array(32).fill(4)],
  }).script,
) as CSVMultisigTapscript.Type

const baseStash = (over: Partial<StashedV4Forfeit> = {}): StashedV4Forfeit => ({
  contractVersion: 'v4',
  gameId: 'g1',
  tier: 0,
  potOutpoint,
  covenant: covenant(),
  forfeitClaimableAt: 1_900_000_000,
  forfeitEmulatorUrl: 'http://emulator:7073',
  playerSecretHex: null,
  createdAt: 1_800_000_000,
  ...over,
})

describe('rebuildJointPot', () => {
  it('rebuilds a deterministic 34-byte p2tr pot from covenant params', () => {
    const a = rebuildJointPot(covenant())
    const b = rebuildJointPot(covenant())
    expect(a.pkScript.length).toBe(34)
    expect(a.pkScript[0]).toBe(0x51) // OP_1
    expect(hexstr(a.pkScript)).toBe(hexstr(b.pkScript))
  })
})

describe('player funding authorization', () => {
  const terms = {
    playerPubkey: xonly(2), playerHash: h(0xbb), payoutPkScript: PLAYER_PAYOUT,
    serverPubkey: xonly(3), emulatorPubkey: xonly(4), playerStake: 1000, minimumHouseStake: 1000,
    chainTime: 1_800_000_000, wallTime: 1_800_000_000,
    oddsN: 2, oddsTarget: 1, oddsLo: 0,
  }
  const termsCovenant = (over: Partial<V4CovenantParams> = {}) => covenant({ cancelDelay: 1_800_000_600, finalExpiration: 1_800_001_200, ...over })
  function proposal(cv = termsCovenant()): V4PlayResponse {
    return {
      gameId: 'game', potAddress: rebuildJointPot(cv).address('tark', xonlyBytes(3)).encode(),
      networkHrp: 'tark', pot: cv.playerStake + cv.houseStake, betAmount: 1000,
      houseStake: cv.houseStake, houseInputs: [], housePubkey: cv.creatorPubkey,
      houseHash: cv.creatorHash, serverPubkey: cv.serverPubkey, emulatorPubkey: cv.emulatorPubkey,
      finalExpiration: cv.finalExpiration, oddsN: cv.oddsN, oddsTarget: cv.oddsTarget, oddsLo: cv.oddsLo, covenant: cv,
    }
  }

  it('accepts the actual compiled pot for the player-selected terms', () => {
    expect(() => validatePlay(proposal(), terms)).not.toThrow()
  })

  it('refuses an arbitrary funding address beside otherwise correct covenant JSON', () => {
    const play = proposal()
    play.potAddress = proposal(termsCovenant({ playerHash: h(0xcc) })).potAddress
    expect(() => validatePlay(play, terms)).toThrow('funding address')
  })

  it.each([
    [{ playerHash: h(0xcc) }, 'player'],
    [{ playerPayoutPkScript: p2tr(0x30) }, 'payout'],
    [{ oddsTarget: 2 }, 'odds'],
    [{ houseStake: 999 }, 'stakes'],
  ] as const)('refuses changed committed terms even when the address matches them: %s', (change, error) => {
    expect(() => validatePlay(proposal(termsCovenant(change)), terms)).toThrow(error)
  })

  it('refuses a house-selected emulator key even when the entire address matches it', () => {
    expect(() => validatePlay(proposal(termsCovenant({ emulatorPubkey: xonly(5) })), terms)).toThrow('cosigner')
  })

  it.each([
    { cancelDelay: 1_799_999_999 },
    { cancelDelay: 1_800_000_030 },
    { finalExpiration: 1_800_000_650 },
    { finalExpiration: 1_900_000_000 },
  ])('refuses past, short, or excessive recovery windows before funding: %s', change => {
    expect(() => validatePlay(proposal(termsCovenant(change)), terms)).toThrow('unsafe funding window')
  })

  it('uses current wall time even when the chain clock is stale', () => {
    expect(() => validatePlay(proposal(), { ...terms, chainTime: 1_799_999_000, wallTime: 1_800_000_550 })).toThrow('unsafe funding window')
  })
})

describe('authoritative recovery cleanup', () => {
  beforeEach(async () => { await saveV4Forfeits([]) })
  const checkpointId = '33'.repeat(32)
  function coin(stash: StashedV4Forfeit, over: Partial<VirtualCoin> = {}): VirtualCoin {
    const pot = rebuildJointPot(stash.covenant)
    return {
      ...(stash.stageTwoOutpoint ?? stash.potOutpoint),
      createdAt: new Date(), status: { confirmed: false },
      script: hexstr(stash.stageTwoOutpoint ? pot.stageTwo.pkScript : pot.pkScript),
      isUnrolled: false, ...over,
    }
  }
  function spend(script: Uint8Array, inputTxid = checkpointId): Transaction {
    const tx = new Transaction()
    tx.addInput({ txid: inputTxid, index: 0, witnessUtxo: { script: rebuildJointPot(covenant()).pkScript, amount: 2000n } })
    tx.addOutput({ script, amount: 2000n })
    return tx
  }
  function source(coins: VirtualCoin[], tx?: Transaction): Pick<IndexerProvider, 'getVtxos' | 'getVirtualTxs'> {
    return {
      getVtxos: vi.fn(async () => ({ vtxos: coins })),
      getVirtualTxs: vi.fn(async () => ({ txs: tx ? [base64.encode(tx.toPSBT())] : [] })),
    }
  }

  it('keeps the player secret while the actual pot is unspent, regardless of a claimed house resolution', async () => {
    const stash = { ...baseStash({ playerSecretHex: '01'.repeat(17), confirmationPending: true }), status: 'resolved' }
    await putV4Forfeit(stash)
    expect((await reconcileRecovery(stash, source([coin(stash)]))).kind).toBe('unspent')
    expect((await loadV4Forfeits())[0].playerSecretHex).toBe(stash.playerSecretHex)
  })

  it('keeps recovery after a missing-input/indexer-lag answer to an ambiguous broadcast', async () => {
    const stash = baseStash({ confirmationPending: true })
    await putV4Forfeit(stash)
    const indexer = source([])
    indexer.getVtxos = vi.fn().mockRejectedValue(new Error('VTXO_NOT_FOUND'))
    expect((await reconcileRecovery(stash, indexer)).kind).toBe('pending')
    expect((await loadV4Forfeits())[0].confirmationPending).toBe(true)
  })

  it('does not treat an unknown outpoint as evidence of a completed spend', async () => {
    const stash = baseStash()
    await putV4Forfeit(stash)
    expect((await reconcileRecovery(stash, source([]))).kind).toBe('pending')
    expect(await loadV4Forfeits()).toHaveLength(1)
  })

  it('clears only after the known operator reports and supplies the exact pot spend', async () => {
    const stash = baseStash()
    await putV4Forfeit(stash)
    const tx = spend(new Uint8Array(Buffer.from(PLAYER_PAYOUT, 'hex')))
    const observed = coin(stash, { isSpent: true, spentBy: checkpointId, arkTxId: tx.id })
    expect((await reconcileRecovery(stash, source([observed], tx))).kind).toBe('spent')
    expect(await loadV4Forfeits()).toEqual([])
  })

  it('keeps the record when a reported spend transaction does not spend its checkpoint', async () => {
    const stash = baseStash()
    await putV4Forfeit(stash)
    const tx = spend(new Uint8Array(Buffer.from(PLAYER_PAYOUT, 'hex')), '44'.repeat(32))
    const observed = coin(stash, { isSpent: true, spentBy: checkpointId, arkTxId: tx.id })
    expect((await reconcileRecovery(stash, source([observed], tx))).kind).toBe('pending')
    expect(await loadV4Forfeits()).toHaveLength(1)
  })

  it('adopts the contest continuation after a stage-one crash instead of deleting the secret', async () => {
    const stash = baseStash({ playerSecretHex: '01'.repeat(17) })
    await putV4Forfeit(stash)
    const tx = spend(rebuildJointPot(stash.covenant).stageTwo.pkScript)
    const observed = coin(stash, { isSpent: true, spentBy: checkpointId, arkTxId: tx.id })
    expect((await reconcileRecovery(stash, source([observed], tx))).kind).toBe('staged')
    const saved = (await loadV4Forfeits())[0]
    expect(saved.stageTwoOutpoint).toEqual({ txid: tx.id, vout: 0, value: 2000 })
    expect(saved.playerSecretHex).toBe(stash.playerSecretHex)
  })

  it('accepts a confirmed onchain spend after unroll, while keeping an unconfirmed one', async () => {
    const stash = baseStash()
    await putV4Forfeit(stash)
    const tx = spend(new Uint8Array(Buffer.from(PLAYER_PAYOUT, 'hex')), stash.potOutpoint.txid)
    const chain = {
      getTxOutspends: vi.fn(async () => [{ spent: true, txid: tx.id }]),
      getTxStatus: vi.fn(async () => ({ confirmed: false as const })),
      getRawTransaction: vi.fn(async () => tx.toBytes(false, false)),
    }
    expect((await reconcileRecovery(stash, source([]), chain)).kind).toBe('pending')
    expect(await loadV4Forfeits()).toHaveLength(1)
    const confirmed = { ...chain, getTxStatus: vi.fn(async () => ({ confirmed: true as const, blockTime: 1_800_000_000, blockHeight: 100 })) }
    expect((await reconcileRecovery(stash, source([]), confirmed)).kind).toBe('spent')
    expect(await loadV4Forfeits()).toEqual([])
  })
})

describe('buildV4SelfRefund', () => {
  it('builds a valid refund tx splitting the pot back to both payouts', () => {
    const built = buildV4SelfRefund(baseStash(), serverUnroll)
    // The arkTx spends the single pot input; outputs 0/1 are the cooperativeSpend
    // split (player stake → player payout, house stake → house payout). The SDK may
    // append anchor outputs after them, so assert the split slots, not the exact count.
    expect(built.arkTx.inputsLength).toBe(1)
    expect(built.arkTx.outputsLength).toBeGreaterThanOrEqual(2)
    expect(built.checkpoints.length).toBe(1)

    const out0 = built.arkTx.getOutput(0)
    const out1 = built.arkTx.getOutput(1)
    expect(out0?.amount).toBe(1000n) // playerStake
    expect(out1?.amount).toBe(1000n) // houseStake
    // Output 0 pays the player's payout pkScript (our stake comes home); output 1 the house's.
    expect(hexstr(out0!.script!)).toBe(PLAYER_PAYOUT)
    expect(hexstr(out1!.script!)).toBe(covenant().housePayoutPkScript)
  })

  it('produces a split that pays exactly the covenant stakes (variable odds)', () => {
    const cv = covenant({ oddsN: 6, oddsTarget: 1, oddsLo: 0, playerStake: 1000, houseStake: 5000 })
    const built = buildV4SelfRefund(
      { covenant: cv, potOutpoint: { txid: '22'.repeat(32), vout: 0, value: 6000 } },
      serverUnroll,
    )
    expect(built.arkTx.getOutput(0)?.amount).toBe(1000n) // player stake back
    expect(built.arkTx.getOutput(1)?.amount).toBe(5000n) // house stake back
  })

  it('fails CLOSED when the covenant stakes do not sum to the pot value', () => {
    // playerStake + houseStake = 2000, but the pot says 9999 — buildJointPotRefundTx
    // rejects the unbalanced split rather than producing a wrong refund.
    expect(() =>
      buildV4SelfRefund({ covenant: covenant(), potOutpoint: { ...potOutpoint, value: 9999 } }, serverUnroll),
    ).toThrow(/must equal the pot value/i)
  })
})

describe('pickV4ClaimPath', () => {
  it('picks self-refund when the secret is null (a restored stash)', () => {
    expect(pickV4ClaimPath({ playerSecretHex: null })).toBe('self-refund')
  })
  it('picks self-refund when the secret is an empty string (corrupt — fail safe)', () => {
    expect(pickV4ClaimPath({ playerSecretHex: '' })).toBe('self-refund')
  })
  it('picks forfeit when a real secret is present', () => {
    expect(pickV4ClaimPath({ playerSecretHex: '00'.repeat(17) })).toBe('forfeit')
  })
})

describe('isAlreadySpentError', () => {
  it('matches the spent/missing-input signals (treated as success → clear the stash)', () => {
    for (const m of [
      'VTXO_ALREADY_SPENT',
      'input already spent',
      'vtxo not found',
      'VTXO_NOT_FOUND',
      'missing input',
      'unknown input',
    ]) {
      expect(isAlreadySpentError(m)).toBe(true)
    }
  })
  it('does NOT match a CLTV lock or a generic error (must keep retrying)', () => {
    expect(isAlreadySpentError('FORFEIT_CLOSURE_LOCKED')).toBe(false)
    expect(isAlreadySpentError('locktime not satisfied')).toBe(false)
    expect(isAlreadySpentError('internal server error')).toBe(false)
  })
})

describe('isTransientSelfRefundError', () => {
  it('classifies CLTV-lock + network failures as transient (retry, do not back off)', () => {
    for (const m of [
      'Not reclaimable yet — the chain hasn’t mined a block past the timelock.',
      'FORFEIT locktime not satisfied',
      'request timed out',
      'failed to fetch',
      '503 Service Unavailable',
    ]) {
      expect(isTransientSelfRefundError(m)).toBe(true)
    }
  })
  it('classifies a hard emulator rejection as permanent (back off — would spam)', () => {
    expect(isTransientSelfRefundError('Emulator rejected v0.4 self-refund: invalid split')).toBe(false)
  })
})

describe('rearmV4ReclaimHint', () => {
  const hint = (over: Partial<V4ReclaimHint> = {}): V4ReclaimHint => ({
    gameId: 'g-restore',
    contractVersion: 'v4',
    potOutpoint: { txid: '33'.repeat(32), vout: 0, value: 2000 },
    covenant: covenant(),
    forfeitClaimableAt: 1_900_000_000,
    forfeitEmulatorUrl: 'http://emulator:7073',
    playerSecretHex: null,
    ...over,
  })
  const args = (over: Partial<Parameters<typeof rearmV4ReclaimHint>[0]> = {}) => ({
    hint: hint(),
    status: 'pending',
    expectedPayoutPkScriptHex: PLAYER_PAYOUT,
    fallbackEmulatorUrl: undefined as string | undefined,
    ...over,
  })

  it('re-arms a pending hint into a no-secret self-refund stash that pays us', () => {
    const d = rearmV4ReclaimHint(args())
    expect(d.kind).toBe('rearm')
    if (d.kind !== 'rearm') throw new Error('expected rearm')
    expect(d.stash.playerSecretHex).toBeNull()
    expect(d.stash.contractVersion).toBe('v4')
    expect(d.stash.gameId).toBe('g-restore')
    expect(d.stash.potOutpoint).toEqual({ txid: '33'.repeat(32), vout: 0, value: 2000 })
    expect(d.stash.forfeitEmulatorUrl).toBe('http://emulator:7073')
    // The rebuilt stash drives a buildable self-refund (the covenant is intact).
    expect(() => buildV4SelfRefund(d.stash, serverUnroll)).not.toThrow()
  })

  it('skips a non-pending game (resolved/expired → nothing to reclaim)', () => {
    expect(rearmV4ReclaimHint(args({ status: 'resolved' }))).toEqual({ kind: 'skip', reason: 'not-pending' })
    expect(rearmV4ReclaimHint(args({ status: 'expired' }))).toEqual({ kind: 'skip', reason: 'not-pending' })
  })

  it('skips an incomplete hint (no covenant, or a pre-co-fund null pot outpoint)', () => {
    expect(rearmV4ReclaimHint(args({ hint: hint({ covenant: null }) }))).toEqual({ kind: 'skip', reason: 'incomplete' })
    expect(
      rearmV4ReclaimHint(args({ hint: hint({ potOutpoint: { txid: null, vout: 0, value: null } }) })),
    ).toEqual({ kind: 'skip', reason: 'incomplete' })
    expect(
      rearmV4ReclaimHint(args({ hint: hint({ potOutpoint: { txid: '33'.repeat(32), vout: 0, value: null } }) })),
    ).toEqual({ kind: 'skip', reason: 'incomplete' })
  })

  it('skips a hint whose covenant pays a different wallet (anti-tamper)', () => {
    expect(rearmV4ReclaimHint(args({ expectedPayoutPkScriptHex: p2tr(0x99) }))).toEqual({
      kind: 'skip',
      reason: 'payout-mismatch',
    })
  })

  it('skips when no emulator URL is available anywhere', () => {
    expect(
      rearmV4ReclaimHint(args({ hint: hint({ forfeitEmulatorUrl: null }), fallbackEmulatorUrl: undefined })),
    ).toEqual({ kind: 'skip', reason: 'no-emulator' })
  })

  it('falls back to the network emulator URL when the hint omits one', () => {
    const d = rearmV4ReclaimHint(
      args({ hint: hint({ forfeitEmulatorUrl: null }), fallbackEmulatorUrl: 'http://net-emu:7073' }),
    )
    expect(d.kind).toBe('rearm')
    if (d.kind !== 'rearm') throw new Error('expected rearm')
    expect(d.stash.forfeitEmulatorUrl).toBe('http://net-emu:7073')
  })

  it('reports the gates in priority order (not-pending → incomplete → payout → emulator)', () => {
    // A resolved + incomplete + foreign + emulator-less hint reports not-pending first.
    const d = rearmV4ReclaimHint(
      args({
        status: 'resolved',
        hint: hint({ covenant: null, forfeitEmulatorUrl: null }),
        expectedPayoutPkScriptHex: p2tr(0x99),
      }),
    )
    expect(d).toEqual({ kind: 'skip', reason: 'not-pending' })
  })
})
