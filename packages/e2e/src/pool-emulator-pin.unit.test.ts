import { networks, resolveEmulatorPubkey, toXOnly } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import type { AppDeps } from 'arkade-coinflip-server'
import { makePoolAdapter } from 'arkade-coinflip-server/dist/pool/adapter.js'
import * as emulator from 'arkade-coinflip-server/dist/emulator.js'
import * as vault from 'arkade-coinflip/dist/pool-game-vault.js'
import type { PoolGameDescriptor, PoolSubmitRequest } from 'arkade-coinflip'

describe('pool emulator trust anchor', () => {
  const previous = process.env.POOL_EMULATOR_PUBKEY
  const previousOperatorUrl = process.env.ARK_SERVER_URL
  const deps = { wallet: { network: networks.regtest } } as unknown as AppDeps
  const pinned = toXOnly(hex.decode(resolveEmulatorPubkey(networks.regtest)))
  beforeEach(() => { delete process.env.POOL_EMULATOR_PUBKEY })
  afterEach(() => {
    jest.restoreAllMocks()
    if (previous === undefined) delete process.env.POOL_EMULATOR_PUBKEY
    else process.env.POOL_EMULATOR_PUBKEY = previous
    if (previousOperatorUrl === undefined) delete process.env.ARK_SERVER_URL
    else process.env.ARK_SERVER_URL = previousOperatorUrl
  })

  function signer(bytes: Uint8Array) {
    jest.spyOn(emulator, 'loadEmulatorConfig').mockResolvedValue({ url: 'http://emulator.invalid',
      publicUrl: 'http://emulator.invalid', signerPubkey: bytes, signerPubkeyHex: hex.encode(bytes), version: 'fixture' })
  }

  it('refuses an advertised signer mismatch before issuing any control or share asset', async () => {
    signer(Uint8Array.from(pinned, byte => byte ^ 1))
    const bootstrap = jest.spyOn(vault, 'bootstrapPool')
    const adapter = makePoolAdapter(deps)
    expect(await adapter.available()).toBe(false)
    await expect(adapter.bootstrap({ name: 'Unsupported signer', initialNavSats: '100000' }, {
      load: async () => undefined, save: async () => undefined,
    })).rejects.toThrow(/SDK trust anchor/)
    expect(bootstrap).not.toHaveBeenCalled()
  })

  it('does not treat a custom configured signer as authority over the supported network pin', async () => {
    const custom = Uint8Array.from(pinned, byte => byte ^ 1)
    signer(custom)
    process.env.POOL_EMULATOR_PUBKEY = hex.encode(custom)
    expect(await makePoolAdapter(deps).available()).toBe(false)
  })

  it('accepts the supported signer and rejects a conflicting configured pin', async () => {
    signer(pinned)
    const adapter = makePoolAdapter(deps)
    expect(await adapter.available()).toBe(true)
    process.env.POOL_EMULATOR_PUBKEY = hex.encode(Uint8Array.from(pinned, byte => byte ^ 1))
    expect(await adapter.available()).toBe(false)
  })

  it('loads renewal lineage only from the configured operator, never the published descriptor URL', async () => {
    process.env.ARK_SERVER_URL = 'https://trusted-operator.example'
    const proof = 'cHNiYXRmaXh0dXJl'
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ intent: { proof } })))
    jest.spyOn(vault, 'verifyPoolSubmission').mockImplementationOnce(async (_wallet, _descriptor, _request, options) => {
      expect(await options!.loadRenewalProof!('aa'.repeat(32))).toBe(proof)
      return { status: 'pending' }
    })
    await makePoolAdapter(deps).verify({ operatorUrl: 'https://untrusted-descriptor.example' } as PoolGameDescriptor, {} as PoolSubmitRequest)
    expect(String(fetch.mock.calls[0][0])).toBe(`https://trusted-operator.example/v1/intent?txid=${'aa'.repeat(32)}`)
  })

  it('rejects malformed renewal proof IDs before requesting network data', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch')
    jest.spyOn(vault, 'verifyPoolSubmission').mockImplementationOnce(async (_wallet, _descriptor, _request, options) => {
      await expect(options!.loadRenewalProof!('../another-endpoint')).rejects.toThrow(/proof ID/)
      return { status: 'pending' }
    })
    await makePoolAdapter(deps).verify({} as PoolGameDescriptor, {} as PoolSubmitRequest)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds actual streamed renewal proof size even without a content-length header', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(1_000_001)))
    jest.spyOn(vault, 'verifyPoolSubmission').mockImplementationOnce(async (_wallet, _descriptor, _request, options) => {
      await expect(options!.loadRenewalProof!('aa'.repeat(32))).rejects.toThrow(/size limit/)
      return { status: 'pending' }
    })
    await makePoolAdapter(deps).verify({} as PoolGameDescriptor, {} as PoolSubmitRequest)
  })
})
