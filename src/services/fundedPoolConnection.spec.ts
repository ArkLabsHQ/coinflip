import { beforeEach, describe, expect, it } from 'vitest'
import { readVerifiedFundedPool, readVerifiedWalletNetwork, rememberVerifiedFundedPool, rememberVerifiedWalletNetwork } from './fundedPoolConnection'
import type { NetworkResponse } from './api'
import type { FundedPoolDescriptor } from './fundedPoolTypes'

const connection: NetworkResponse = { network: 'regtest', operatorUrl: 'http://localhost:37770', esploraUrl: 'http://localhost:38000/api',
  emulator: { url: 'http://localhost:37773', signerPubkey: '02' + '11'.repeat(32), version: '0.0.9' } }
const context = { publicKey: 'aa'.repeat(32), network: 'regtest', operatorUrl: connection.operatorUrl }
beforeEach(() => localStorage.clear())
describe('verified public pool connection cache', () => {
  it('scopes wallet connection records by public key and exact operator URL', () => {
    rememberVerifiedWalletNetwork(context.publicKey, connection)
    expect(readVerifiedWalletNetwork(context.publicKey, context.operatorUrl)).toEqual({ ...connection, protocolVersion: 'v4' })
    expect(readVerifiedWalletNetwork('bb'.repeat(32), context.operatorUrl)).toBeUndefined()
    expect(readVerifiedWalletNetwork(context.publicKey, 'https://other.example')).toBeUndefined()
  })
  it('persists descriptor and public endpoints without balances or recovery secrets', () => {
    const descriptor = { network: context.network, operatorUrl: context.operatorUrl, bootstrapTxid: 'cc'.repeat(32) } as FundedPoolDescriptor
    rememberVerifiedFundedPool(context, descriptor, connection)
    expect(readVerifiedFundedPool(context)?.descriptor).toEqual(descriptor)
    expect(readVerifiedFundedPool({ ...context, network: 'bitcoin' })).toBeUndefined()
    expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!)).join('')).not.toMatch(/navSats|supply|playerSecret|signedArk/)
  })
  it('rejects connection records with credential-bearing URLs or mismatched networks', () => {
    expect(() => rememberVerifiedWalletNetwork(context.publicKey, { ...connection, operatorUrl: 'http://user:pass@example.test' })).toThrow()
    expect(() => rememberVerifiedFundedPool(context, { network: 'bitcoin', operatorUrl: context.operatorUrl } as FundedPoolDescriptor, connection)).toThrow(/context mismatch/)
  })
})
