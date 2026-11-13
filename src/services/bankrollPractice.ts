import { computed, readonly, ref, shallowRef } from 'vue'
import {
  beginClose, closeEpoch, createBankroll, fundWager, openEpoch, redeem, reserveWager,
  settleWager, subscribe, type BankrollOutcome, type BankrollState,
} from 'arkade-coinflip/dist/bankroll.js'

export interface PracticeActivity {
  readonly id: string
  readonly kind: 'join' | 'redeem' | 'round'
  readonly outcome?: BankrollOutcome
  readonly at: number
  readonly amountSats: bigint
  readonly shareUnits?: bigint
  readonly pnlSats: bigint
  readonly operatorFeeSats: bigint
  readonly memberValueSats: bigint
}

export interface PracticeHistoryPoint {
  readonly at: number
  readonly navSats: bigint
  readonly memberValueSats: bigint
}

export interface PracticeSession {
  readonly pool: BankrollState
  readonly memberShares: bigint
  readonly cashSats: bigint
  readonly contributedSats: bigint
  readonly redeemedSats: bigint
  readonly operatorFeesSats: bigint
  readonly version: number
  readonly activity: readonly PracticeActivity[]
  readonly history: readonly PracticeHistoryPoint[]
}

interface PracticeQuote {
  ownershipBps: bigint
  nextPoolNavSats: bigint
  memberValueSats: bigint
}

export interface PracticeJoinQuote extends PracticeQuote { mintedShares: bigint }
export interface PracticeRedeemQuote extends PracticeQuote { payoutSats: bigint }
export interface BankrollPracticeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface PracticeCommand {
  kind: PracticeActivity['kind']
  amount: string
  at: number
  outcome?: BankrollOutcome
}

type AccountChange = Pick<PracticeSession, 'pool' | 'memberShares' | 'cashSats' | 'contributedSats' | 'redeemedSats' | 'operatorFeesSats'>
interface Transition { account: AccountChange; pnlSats: bigint; operatorFeeSats: bigint }
export const BANKROLL_PRACTICE_STORAGE_KEY = 'coinflip.bankroll-practice.v1'
export const PRACTICE_INITIAL_CAPITAL_SATS = 100_000n
const SESSION_ONLY = 'Session only: practice progress will not be saved after this tab closes.'

function initialSession(at: number, version = 0): PracticeSession {
  const pool = createBankroll({ initialSats: PRACTICE_INITIAL_CAPITAL_SATS, operatorFeeBps: 2000n, maxStakeBps: 2000n })
  return Object.freeze({ pool, memberShares: 0n, cashSats: 100_000n, contributedSats: 0n,
    redeemedSats: 0n, operatorFeesSats: 0n, version, activity: Object.freeze([]),
    history: Object.freeze([Object.freeze({ at, navSats: pool.navSats, memberValueSats: 0n })]) })
}

function positive(value: bigint): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new Error('Enter a positive whole number of sats or shares')
}

function memberValue(session: Pick<PracticeSession, 'memberShares' | 'pool'>): bigint {
  return session.pool.totalShares ? session.memberShares * session.pool.navSats / session.pool.totalShares : 0n
}

function ownershipBps(session: Pick<PracticeSession, 'memberShares' | 'pool'>): bigint {
  return session.pool.totalShares ? session.memberShares * 10_000n / session.pool.totalShares : 0n
}

function joining(session: PracticeSession, sats: bigint): Transition {
  positive(sats)
  if (sats > session.cashSats) throw new Error('Contribution exceeds your practice cash')
  const result = subscribe(session.pool, sats)
  const account = { ...session, pool: result.state, memberShares: session.memberShares + result.mintedShares,
    cashSats: session.cashSats - sats, contributedSats: session.contributedSats + sats }
  return { account, pnlSats: 0n, operatorFeeSats: 0n }
}

function redeeming(session: PracticeSession, shares: bigint): Transition {
  positive(shares)
  if (shares > session.memberShares) throw new Error('Redemption exceeds your practice shares')
  const result = redeem(session.pool, shares)
  const account = { ...session, pool: result.state, memberShares: session.memberShares - shares,
    cashSats: session.cashSats + result.payoutSats, redeemedSats: session.redeemedSats + result.payoutSats }
  return { account, pnlSats: 0n, operatorFeeSats: 0n }
}

function playing(session: PracticeSession, stake: bigint, outcome?: BankrollOutcome): Transition {
  positive(stake)
  if (outcome !== 'house' && outcome !== 'player' && outcome !== 'refund') throw new Error('Choose a valid practice outcome')
  const id = `practice-${session.version + 1}`
  const funded = fundWager(reserveWager(openEpoch(session.pool), id, stake, stake), id)
  const result = closeEpoch(beginClose(settleWager(funded, id, outcome)))
  return { account: { ...session, pool: result.state, operatorFeesSats: session.operatorFeesSats + result.operatorFeeSats },
    pnlSats: result.pnlSats, operatorFeeSats: result.operatorFeeSats }
}

function changed(session: PracticeSession, command: PracticeCommand): Transition {
  const amount = BigInt(command.amount)
  if (command.kind === 'join') return joining(session, amount)
  if (command.kind === 'redeem') return redeeming(session, amount)
  return playing(session, amount, command.outcome)
}

function nextVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 0 || version === Number.MAX_SAFE_INTEGER) throw new Error('Practice version limit reached; start a new session')
  return version + 1
}

function apply(session: PracticeSession, command: PracticeCommand): PracticeSession {
  const version = nextVersion(session.version)
  const { account, pnlSats, operatorFeeSats } = changed(session, command)
  const memberValueSats = memberValue(account)
  const amountSats = command.kind === 'redeem' ? account.cashSats - session.cashSats : BigInt(command.amount)
  const shareUnits = command.kind === 'join' ? account.memberShares - session.memberShares
    : command.kind === 'redeem' ? session.memberShares - account.memberShares : undefined
  const activity = Object.freeze({ id: `practice-${version}`, kind: command.kind, outcome: command.outcome,
    at: command.at, amountSats, shareUnits, pnlSats, operatorFeeSats, memberValueSats })
  return Object.freeze({ ...account, version, activity: Object.freeze([activity, ...session.activity].slice(0, 60)),
    history: Object.freeze([...session.history, Object.freeze({ at: command.at, navSats: account.pool.navSats, memberValueSats })].slice(-60)) })
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid saved practice data')
  return value as Record<string, unknown>
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new Error('Invalid saved practice timestamp')
  return value
}

function savedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid saved practice version')
  return value
}

function savedCommand(value: unknown): PracticeCommand {
  const entry = record(value)
  if (entry.kind !== 'join' && entry.kind !== 'redeem' && entry.kind !== 'round') throw new Error('Invalid saved practice action')
  if (typeof entry.amount !== 'string' || !/^[1-9]\d*$/.test(entry.amount)) throw new Error('Invalid saved practice amount')
  if (entry.kind === 'round' ? !['house', 'player', 'refund'].includes(String(entry.outcome)) : entry.outcome !== undefined) throw new Error('Invalid saved practice outcome')
  return { kind: entry.kind, amount: entry.amount, at: timestamp(entry.at), outcome: entry.outcome as BankrollOutcome | undefined }
}

function restore(saved: string): { session: PracticeSession; journal: PracticeCommand[]; initialVersion: number; startedAt: number } {
  const document = record(JSON.parse(saved))
  if (document.schemaVersion !== 1 || !Array.isArray(document.journal)) throw new Error('Unsupported saved practice format')
  const initialVersion = savedVersion(document.initialVersion)
  const startedAt = timestamp(document.startedAt)
  const journal = document.journal.map(savedCommand)
  let session = initialSession(startedAt, initialVersion)
  for (const command of journal) {
    if (command.at < session.history[session.history.length - 1].at) throw new Error('Saved practice actions are out of order')
    session = apply(session, command)
  }
  return { session, journal, initialVersion, startedAt }
}

export function createBankrollPractice(storage?: BankrollPracticeStorage | null) {
  let startedAt = Date.now()
  let initialVersion = 0
  let journal: PracticeCommand[] = []
  let session = initialSession(startedAt)
  let canSave = !!storage
  const storageWarning = ref<string | null>(storage ? null : SESSION_ONLY)
  try {
    const saved = storage?.getItem(BANKROLL_PRACTICE_STORAGE_KEY)
    if (saved !== null && saved !== undefined) ({ session, journal, initialVersion, startedAt } = restore(saved))
  } catch {
    canSave = false
    storageWarning.value = 'Saved practice progress could not be verified. This tab starts a new session; reset to replace the saved data.'
  }
  const state = shallowRef(session)

  function save(): void {
    if (!canSave || !storage) return
    try { storage.setItem(BANKROLL_PRACTICE_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, initialVersion, startedAt, journal })) }
    catch { canSave = false; storageWarning.value = SESSION_ONLY }
  }

  function commit(kind: PracticeCommand['kind'], amount: bigint, expectedVersion?: number, outcome?: BankrollOutcome): PracticeSession {
    positive(amount)
    if (expectedVersion !== undefined && expectedVersion !== state.value.version) throw new Error('Practice changed; review a fresh quote before confirming')
    const at = Math.max(Date.now(), state.value.history[state.value.history.length - 1].at)
    const command = { kind, amount: amount.toString(), at, outcome }
    const next = apply(state.value, command)
    journal = [...journal, command]
    state.value = next
    save()
    return next
  }

  function quoteJoin(sats: bigint): PracticeJoinQuote {
    const { account } = joining(state.value, sats)
    return { mintedShares: account.memberShares - state.value.memberShares, ownershipBps: ownershipBps(account),
      nextPoolNavSats: account.pool.navSats, memberValueSats: memberValue(account) }
  }

  function quoteRedeem(shares: bigint): PracticeRedeemQuote {
    const { account } = redeeming(state.value, shares)
    return { payoutSats: account.cashSats - state.value.cashSats, ownershipBps: ownershipBps(account),
      nextPoolNavSats: account.pool.navSats, memberValueSats: memberValue(account) }
  }

  function reset(): PracticeSession {
    initialVersion = nextVersion(state.value.version)
    startedAt = Date.now()
    journal = []
    state.value = initialSession(startedAt, initialVersion)
    canSave = !!storage
    storageWarning.value = storage ? null : SESSION_ONLY
    save()
    return state.value
  }

  return { state: readonly(state), storageWarning,
    memberValue: computed(() => memberValue(state.value)), ownershipBps: computed(() => ownershipBps(state.value)),
    memberPnl: computed(() => memberValue(state.value) + state.value.redeemedSats - state.value.contributedSats),
    quoteJoin, quoteRedeem, join: (sats: bigint, expectedVersion?: number) => commit('join', sats, expectedVersion),
    redeemShares: (shares: bigint, expectedVersion?: number) => commit('redeem', shares, expectedVersion),
    playRound: (outcome: BankrollOutcome, stake: bigint) => commit('round', stake, undefined, outcome), reset }
}

export type BankrollPractice = ReturnType<typeof createBankrollPractice>
let singleton: BankrollPractice | undefined

export function useBankrollPractice(): BankrollPractice {
  if (!singleton) {
    let storage: BankrollPracticeStorage | null = null
    try { storage = globalThis.localStorage } catch { /* Browser storage can be disabled. */ }
    singleton = createBankrollPractice(storage)
  }
  return singleton
}
