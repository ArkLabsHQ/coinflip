import { arkade, decodeTapscript, scriptFromTapLeafScript } from '@arkade-os/sdk'
import { CoinflipJointPotScript, emulator } from 'arkade-coinflip'
import { contractOptions, toHex } from './test-helpers/coinflip-fixture'
const { schnorr, secp256k1 } = require('@noble/curves/secp256k1.js')

describe('compiled covenant key binding', () => {
  const options = contractOptions()
  const pot = new CoinflipJointPotScript(options)

  it('binds the forfeit emulator key to the compiled covenant using ArkScriptHash', () => {
    const body = pot.forfeitArkadeScript
    const hash = schnorr.utils.taggedHash('ArkScriptHash', body)
    expect(toHex(arkade.arkadeScriptHash(body))).toBe(toHex(hash))
    const point = secp256k1.Point.fromHex('02' + toHex(options.emulatorPubkey))
    const scalar = BigInt('0x' + toHex(hash)) % secp256k1.Point.Fn.ORDER
    const expected = point.add(secp256k1.Point.BASE.multiply(scalar)).toBytes(true).slice(1)
    const decoded = decodeTapscript(scriptFromTapLeafScript(pot.playerForfeitExit()))
    expect(decoded.params.pubkeys.map(toHex)).toEqual([toHex(options.playerPubkey), toHex(expected)])
    expect(toHex(arkade.computeArkadeScriptPublicKey(options.emulatorPubkey, body))).toBe(toHex(expected))
  })

  it('changes the forfeit authority when the committed stake changes', () => {
    const changed = new CoinflipJointPotScript(contractOptions({ playerStake: options.playerStake + 1n }))
    expect(toHex(changed.forfeitArkadeScript)).not.toBe(toHex(pot.forfeitArkadeScript))
    const key = (p: CoinflipJointPotScript) =>
      toHex(decodeTapscript(scriptFromTapLeafScript(p.playerForfeitExit())).params.pubkeys[1])
    expect(key(changed)).not.toBe(key(pot))
  })
})

describe('emulator witness encoding', () => {
  it.each([
    [0, []], [1, [1]], [127, [127]], [128, [128, 0]], [255, [255, 0]], [256, [0, 1]],
  ])('encodes output index %s as a minimal positive ScriptNum', (index, expected) => {
    expect(Array.from(emulator.encodeIndex(index as number))).toEqual(expected)
  })

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid indices: %s', index => {
    expect(() => emulator.encodeIndex(index)).toThrow(/safe integer/)
  })

  it('encodes the compact-size stack and item lengths, including the 253-byte boundary', () => {
    expect(Array.from(emulator.encodeWitness([]))).toEqual([0])
    expect(Array.from(emulator.encodeWitness([new Uint8Array()]))).toEqual([1, 0])
    expect(Array.from(emulator.encodeWitness([new Uint8Array([1])]))).toEqual([1, 1, 1])
    const encoded = emulator.encodeWitness([new Uint8Array(253).fill(0xaa)])
    expect(Array.from(encoded.slice(0, 4))).toEqual([1, 0xfd, 0xfd, 0])
    expect(encoded.length).toBe(257)
  })
})
