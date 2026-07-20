/**
 * E2E tests for arkade-coinflip.
 *
 * Tests run against arkade-regtest (Docker compose stack).
 * The CI workflow starts the regtest environment before running these tests.
 */

import { hex } from '@scure/base'
import {
  SingleKey,
  RestArkProvider,
  DefaultVtxo,
} from '@arkade-os/sdk'

// -- Integration Tests (require regtest) --

/** Strip prefix byte from compressed pubkey to get x-only (32 bytes) */
function toXOnly(pubkey: Uint8Array): Uint8Array {
  return pubkey.length === 33 ? pubkey.slice(1) : pubkey
}

const ARK_SERVER_URL = process.env.ARK_SERVER_URL || 'http://localhost:7070'

describe('integration: ark server connection', () => {
  // Skip integration tests if ARK_SERVER_URL is not available
  let arkAvailable = false

  beforeAll(async () => {
    try {
      const resp = await fetch(`${ARK_SERVER_URL}/v1/info`, {
        signal: AbortSignal.timeout(5000),
      })
      arkAvailable = resp.ok
    } catch {
      console.log('Ark server not available, skipping integration tests')
    }
  })

  it('should connect to ark server and get info', async () => {
    if (!arkAvailable) return

    const provider = new RestArkProvider(ARK_SERVER_URL)
    const info = await provider.getInfo()

    expect(info.signerPubkey).toBeTruthy()
    expect(info.network).toBe('regtest')
    expect(info.dust).toBeGreaterThan(0n)
  })

  it('should create an identity and derive an ark address', async () => {
    if (!arkAvailable) return

    const identity = SingleKey.fromRandomBytes()
    const pubkey = await identity.xOnlyPublicKey()
    expect(pubkey.length).toBe(32)

    const provider = new RestArkProvider(ARK_SERVER_URL)
    const info = await provider.getInfo()
    const serverPubkey = toXOnly(hex.decode(info.signerPubkey))

    // Create a DefaultVtxo script and derive address
    const vtxoScript = new DefaultVtxo.Script({
      pubKey: pubkey,
      serverPubKey: serverPubkey,
      // SDK 0.4.36 made csvTimelock required; use the SDK's own default
      // (144 blocks) — this test only derives an address, so the exit
      // timelock value is immaterial.
      csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    })

    const address = vtxoScript.address('rark', serverPubkey)
    expect(address.encode().startsWith('rark')).toBe(true)
  })
})
