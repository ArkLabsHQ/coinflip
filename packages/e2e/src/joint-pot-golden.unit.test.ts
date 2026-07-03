/**
 * Golden byte-vectors for the v4 joint-pot contract.
 *
 * Pins the EXACT on-chain output (taproot pkScript + all 8 committed leaf
 * scripts) of the v4 contract for two representative games. This is the
 * regression net that lets `CoinflipJointPotScript` be refactored onto the
 * artifact builder (`buildJointPotArtifactContract`) with confidence: both
 * the class and the builder are asserted against these frozen literals, so a
 * byte drift in EITHER — from the refactor, an SDK bump, or a covenant
 * change — fails loudly. The vectors were captured from the pre-refactor
 * hand-rolled `CoinflipJointPotScript`.
 *
 * If a change here is intentional (e.g. a deliberate covenant redesign), the
 * new address means a NEW contract version — regenerate the vectors and
 * review the diff as a protocol change, never blindly.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { CoinflipJointPotScript, buildJointPotArtifactContract } = require('arkade-coinflip')
const { schnorr } = require('@noble/curves/secp256k1.js')

const xonly = (b: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(b))
const h = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const p2tr = (b: number): Uint8Array => new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(b)])
const toHex = (u8: Uint8Array): string => Buffer.from(u8).toString('hex')

function optsFor(oddsN: number, oddsTarget: number, oddsLo: number) {
  return {
    creatorPubkey: xonly(1),
    playerPubkey: xonly(2),
    serverPubkey: xonly(3),
    creatorHash: h(0xc0),
    playerHash: h(0xd0),
    finalExpiration: 1_900_000_000n,
    cancelDelay: 1_800_000_000n,
    exitDelay: 86_528n,
    oddsN,
    oddsTarget,
    oddsLo,
    emulatorPubkey: xonly(4),
    playerPayoutPkScript: p2tr(0xa0),
    housePayoutPkScript: p2tr(0xb0),
    playerStake: 50_000n,
    houseStake: 50_000n,
  }
}

// Frozen vectors (captured from the pre-refactor CoinflipJointPotScript).
const GOLDEN = {
  coin: {
    opts: optsFor(2, 1, 0),
    pkScript: '5120cebd001f0c6a499dd77a35e9739d85f42201753fefa1eea551574fa8eb33e386',
    leaves: [
      '20531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337ad2008c527695b5e2d84773dff46836034d8508f8131df139cf399d4f2830bcaedaeac',
      '20531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337ad20d13c16d28350ad6747eda8d30d3957ed7fc274b34260646f8f841d8de4408faaac',
      'a820d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d08769204d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ad20531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337ad204d7dce33349460dcd47c13d61f110846a624edc1238daecab1545a9fbebfdce4ac',
      '0400d2496bb17520531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337ad2086fbbfed455fe723962f46977424ad28af1b36287b71a422e808c325ebe465c5ac',
      '03a90040b275204d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ad2008c527695b5e2d84773dff46836034d8508f8131df139cf399d4f2830bcaedaeac',
      '03a90040b275201b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078fad20d13c16d28350ad6747eda8d30d3957ed7fc274b34260646f8f841d8de4408faaac',
      'a820d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0876903a90040b275204d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ad202e1cfe8dfd336dea7d457e31feb2a280031c14f17ba8a500b86731b77912940bac',
      '03a90040b275204d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ad201b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078fac',
    ],
  },
  vodds: {
    opts: optsFor(100, 55, 0),
    pkScript: '5120279cf555c0c76a970eb291c5d832408d9dcf26e620dff7521bdc80c2667eddd0',
    leaves: [
      '20531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337ad20853cbc8e055f5327af305ff9f0ba1960b9f9593fdd10217fc99b241057850edeac',
      '20531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337ad207a7163b066278d4db658adae2184aab34fed27ec3fa110f13ebf5e3daa4b0e31ac',
      'a820d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d08769204d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ad20531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337ad20cb01cf2262ed9c2d28f11f4ebbace692744c438dd78ce41de3108974f51620e7ac',
      '0400d2496bb17520531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337ad2086fbbfed455fe723962f46977424ad28af1b36287b71a422e808c325ebe465c5ac',
      '03a90040b275204d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ad20853cbc8e055f5327af305ff9f0ba1960b9f9593fdd10217fc99b241057850edeac',
      '03a90040b275201b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078fad207a7163b066278d4db658adae2184aab34fed27ec3fa110f13ebf5e3daa4b0e31ac',
      'a820d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0876903a90040b275204d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ad202e1cfe8dfd336dea7d457e31feb2a280031c14f17ba8a500b86731b77912940bac',
      '03a90040b275204d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766ad201b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078fac',
    ],
  },
} as const

function classLeaves(s: InstanceType<typeof CoinflipJointPotScript>): string[] {
  return [
    s.playerWinCovenantScriptHex,
    s.creatorWinCovenantScriptHex,
    s.playerRevealScriptHex,
    s.cooperativeSpendScriptHex,
    s.playerWinExitScriptHex,
    s.creatorWinExitScriptHex,
    s.playerForfeitExitScriptHex,
    s.cooperativeSpendExitScriptHex,
  ]
}

describe('v4 joint-pot golden byte vectors', () => {
  for (const [label, g] of Object.entries(GOLDEN)) {
    describe(label, () => {
      it('CoinflipJointPotScript matches the frozen pkScript + 8 leaves', () => {
        const s = new CoinflipJointPotScript(g.opts)
        expect(toHex(s.pkScript)).toBe(g.pkScript)
        expect(classLeaves(s)).toEqual(g.leaves)
      })

      it('buildJointPotArtifactContract matches the frozen pkScript + 8 leaves', () => {
        const c = buildJointPotArtifactContract(g.opts)
        expect(toHex(c.pkScript)).toBe(g.pkScript)
        expect(c.leafScriptsHex).toEqual(g.leaves)
      })
    })
  }
})
