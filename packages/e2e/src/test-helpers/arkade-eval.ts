/**
 * Minimal in-process evaluator for the arkade-script subset emitted by
 * arkade-win's win-condition body.
 *
 * NOT a full emulator — implements only the opcodes the predicate uses.
 * The regtest e2e is the source of truth for end-to-end behavior;
 * this walker is for fast unit-coverage of the predicate's logical
 * branches (correctness across the (cd, pd, n, lo, target) matrix,
 * out-of-range tiebreaks, missing-packet failure mode).
 *
 * Stack values are stored as bigints for numeric ops, Uint8Arrays for
 * byte strings. Conversion via `asNum` / `asBytes` mirrors the on-chain
 * stack's untyped-byte-string semantics with implicit numeric coercion
 * (CScriptNum minimal LE).
 */

import { sha256 } from '@scure/btc-signer/utils.js'

// ── Opcodes we recognize ───────────────────────────────────────────────
const OP_0 = 0x00
const OP_PUSHDATA1 = 0x4c
const OP_1 = 0x51
const OP_16 = 0x60
const OP_IF = 0x63
const OP_NOTIF = 0x64
const OP_ELSE = 0x67
const OP_ENDIF = 0x68
const OP_VERIFY = 0x69
const OP_2DROP = 0x6d
const OP_DROP = 0x75
const OP_DUP = 0x76
const OP_SWAP = 0x7c
const OP_LEFT = 0x80
const OP_EQUAL = 0x87
const OP_EQUALVERIFY = 0x88
const OP_NOT = 0x91
const OP_ADD = 0x93
const OP_MOD = 0x97
const OP_WITHIN = 0xa5
const OP_SHA256 = 0xa8
const OP_BIN2NUM = 0xd8
const OP_INSPECTPACKET = 0xf4

type StackItem = Uint8Array

class ScriptError extends Error {
  constructor(msg: string) { super(`script: ${msg}`) }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Decode a minimal CScriptNum-encoded byte string into a number.
 * Single-byte 0x00 == 0; otherwise little-endian with the high bit of the
 * top byte as a sign bit.
 */
function asNum(b: StackItem): number {
  if (b.length === 0) return 0
  let n = 0
  for (let i = 0; i < b.length - 1; i++) n |= b[i] << (8 * i)
  const top = b[b.length - 1]
  if (top & 0x80) {
    // Negative
    n |= (top & 0x7f) << (8 * (b.length - 1))
    return -n
  }
  n |= top << (8 * (b.length - 1))
  return n
}

/** Encode a number as a minimal CScriptNum byte string. */
function fromNum(v: number): StackItem {
  if (v === 0) return new Uint8Array(0)
  const neg = v < 0
  let n = Math.abs(v)
  const bytes: number[] = []
  while (n > 0) { bytes.push(n & 0xff); n >>>= 8 }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(neg ? 0x80 : 0x00)
  else if (neg) bytes[bytes.length - 1] |= 0x80
  return new Uint8Array(bytes)
}

/** Truthiness: anything non-zero / non-negative-zero. */
function asBool(b: StackItem): boolean {
  if (b.length === 0) return false
  for (let i = 0; i < b.length - 1; i++) if (b[i] !== 0) return true
  // Last byte: 0 or 0x80 (negative zero) → false
  return (b[b.length - 1] & 0x7f) !== 0
}

/**
 * Run the predicate against a mocked-packet environment.
 *
 * Returns:
 *   - true / false  — script terminated normally; top-of-stack truthy/falsy
 *   - throws        — VERIFY/EQUALVERIFY failed, stack underflow, unknown opcode
 */
export function evalPredicate(
  script: Uint8Array,
  packetsByType: Record<number, Uint8Array>,
): boolean {
  const stack: StackItem[] = []
  // condStack[i] = true means we're executing this branch.
  const condStack: boolean[] = []
  const executing = (): boolean => condStack.every(Boolean)

  let pc = 0
  while (pc < script.length) {
    const op = script[pc++]

    // Push-data opcodes (always parsed for proper PC advance, even when not executing).
    if (op === OP_0) {
      if (executing()) stack.push(new Uint8Array(0))
      continue
    }
    if (op >= 0x01 && op <= 0x4b) {
      // OP_DATA_N: N bytes follow
      const n = op
      if (pc + n > script.length) throw new ScriptError('truncated data push')
      const data = script.slice(pc, pc + n)
      pc += n
      if (executing()) stack.push(data)
      continue
    }
    if (op === OP_PUSHDATA1) {
      if (pc + 1 > script.length) throw new ScriptError('truncated pushdata1 len')
      const n = script[pc++]
      if (pc + n > script.length) throw new ScriptError('truncated pushdata1 data')
      const data = script.slice(pc, pc + n)
      pc += n
      if (executing()) stack.push(data)
      continue
    }
    if (op >= OP_1 && op <= OP_16) {
      if (executing()) stack.push(fromNum(op - 0x50))
      continue
    }

    // Conditional opcodes — handled even when not executing to maintain nesting.
    if (op === OP_IF || op === OP_NOTIF) {
      let branchVal = false
      if (executing()) {
        if (stack.length < 1) throw new ScriptError(`${op === OP_IF ? 'IF' : 'NOTIF'}: stack empty`)
        const top = stack.pop()!
        branchVal = asBool(top)
        if (op === OP_NOTIF) branchVal = !branchVal
      } else {
        branchVal = false  // skipped branch
      }
      condStack.push(branchVal)
      continue
    }
    if (op === OP_ELSE) {
      if (condStack.length === 0) throw new ScriptError('ELSE without IF')
      // Toggle, but only if the enclosing context is executing.
      // Implementation: track an "enclosing executing" flag.
      const enclosing = condStack.length === 1 ? true : condStack.slice(0, -1).every(Boolean)
      if (enclosing) condStack[condStack.length - 1] = !condStack[condStack.length - 1]
      continue
    }
    if (op === OP_ENDIF) {
      if (condStack.length === 0) throw new ScriptError('ENDIF without IF')
      condStack.pop()
      continue
    }

    // Non-conditional opcodes — skip if not executing.
    if (!executing()) continue

    switch (op) {
      case OP_VERIFY: {
        if (stack.length < 1) throw new ScriptError('VERIFY: stack empty')
        const v = stack.pop()!
        if (!asBool(v)) throw new ScriptError('VERIFY failed')
        break
      }
      case OP_DUP: {
        if (stack.length < 1) throw new ScriptError('DUP: stack empty')
        stack.push(new Uint8Array(stack[stack.length - 1]))
        break
      }
      case OP_DROP: {
        if (stack.length < 1) throw new ScriptError('DROP: stack empty')
        stack.pop()
        break
      }
      case OP_2DROP: {
        if (stack.length < 2) throw new ScriptError('2DROP: stack underflow')
        stack.pop(); stack.pop()
        break
      }
      case OP_SWAP: {
        if (stack.length < 2) throw new ScriptError('SWAP: stack underflow')
        const a = stack[stack.length - 1], b = stack[stack.length - 2]
        stack[stack.length - 1] = b; stack[stack.length - 2] = a
        break
      }
      case OP_EQUAL: {
        if (stack.length < 2) throw new ScriptError('EQUAL: stack underflow')
        const a = stack.pop()!, b = stack.pop()!
        stack.push(bytesEqual(a, b) ? fromNum(1) : new Uint8Array(0))
        break
      }
      case OP_EQUALVERIFY: {
        if (stack.length < 2) throw new ScriptError('EQUALVERIFY: stack underflow')
        const a = stack.pop()!, b = stack.pop()!
        if (!bytesEqual(a, b)) throw new ScriptError('EQUALVERIFY failed')
        break
      }
      case OP_NOT: {
        if (stack.length < 1) throw new ScriptError('NOT: stack empty')
        stack.push(asBool(stack.pop()!) ? new Uint8Array(0) : fromNum(1))
        break
      }
      case OP_ADD: {
        if (stack.length < 2) throw new ScriptError('ADD: stack underflow')
        const b = asNum(stack.pop()!), a = asNum(stack.pop()!)
        stack.push(fromNum(a + b))
        break
      }
      case OP_MOD: {
        if (stack.length < 2) throw new ScriptError('MOD: stack underflow')
        const b = asNum(stack.pop()!), a = asNum(stack.pop()!)
        if (b === 0) throw new ScriptError('MOD by zero')
        // Bitcoin script semantics: truncated division (sign follows dividend).
        stack.push(fromNum(a % b))
        break
      }
      case OP_WITHIN: {
        if (stack.length < 3) throw new ScriptError('WITHIN: stack underflow')
        const hi = asNum(stack.pop()!), lo = asNum(stack.pop()!), x = asNum(stack.pop()!)
        stack.push(lo <= x && x < hi ? fromNum(1) : new Uint8Array(0))
        break
      }
      case OP_SHA256: {
        if (stack.length < 1) throw new ScriptError('SHA256: stack empty')
        stack.push(sha256(stack.pop()!))
        break
      }
      case OP_LEFT: {
        if (stack.length < 2) throw new ScriptError('LEFT: stack underflow')
        const n = asNum(stack.pop()!), s = stack.pop()!
        if (n < 0 || n > s.length) throw new ScriptError(`LEFT: invalid n=${n}`)
        stack.push(s.slice(0, n))
        break
      }
      case OP_BIN2NUM: {
        if (stack.length < 1) throw new ScriptError('BIN2NUM: stack empty')
        // Minimal-encode whatever bytes are on top. For our purposes the input
        // is a single byte holding the digit; minimal encoding is the value
        // itself (with the high-bit/0x80 caveat we sidestep by capping n ≤ 128).
        const b = stack.pop()!
        stack.push(fromNum(asNum(b)))
        break
      }
      case OP_INSPECTPACKET: {
        if (stack.length < 1) throw new ScriptError('INSPECTPACKET: stack empty')
        const typeNum = asNum(stack.pop()!)
        const content = packetsByType[typeNum]
        if (content === undefined) {
          stack.push(new Uint8Array(0))
          stack.push(new Uint8Array(0))
        } else {
          stack.push(new Uint8Array(content))
          stack.push(fromNum(1))
        }
        break
      }
      default:
        throw new ScriptError(`unsupported opcode 0x${op.toString(16)} at pc=${pc - 1}`)
    }
  }

  if (condStack.length !== 0) throw new ScriptError('unterminated conditional')
  if (stack.length === 0) return false
  return asBool(stack[stack.length - 1])
}
