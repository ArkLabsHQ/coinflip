import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWalletNetwork, rememberWalletNetwork } from './walletNetwork'
import { getNetwork, type NetworkResponse } from './api'
import { readVerifiedWalletNetwork, rememberVerifiedWalletNetwork } from './fundedPoolConnection'

vi.mock('./api', () => ({ getNetwork: vi.fn() }))
vi.mock('./fundedPoolConnection', () => ({ readVerifiedWalletNetwork: vi.fn(), rememberVerifiedWalletNetwork: vi.fn() }))
const connection: NetworkResponse = { network: 'regtest', operatorUrl: 'http://localhost:37770', esploraUrl: 'http://localhost:38000/api', emulator: { url: 'http://localhost:37773', signerPubkey: '02' + '11'.repeat(32), version: 'v0.0.9' }, protocolVersion: 'v4' }
const fetcher = vi.fn()
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', fetcher) })
afterEach(() => vi.unstubAllGlobals())

describe('wallet connection during coordinator outage', () => {
  it('uses a fresh published connection without consulting recovery storage', async () => {
    vi.mocked(getNetwork).mockResolvedValue(connection)
    expect(await getWalletNetwork('wallet-a', connection.operatorUrl)).toBe(connection)
    expect(readVerifiedWalletNetwork).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses only the same wallet/operator cache after checking its live network', async () => {
    vi.mocked(getNetwork).mockRejectedValue(new Error('Coordinator offline'))
    vi.mocked(readVerifiedWalletNetwork).mockReturnValue(connection)
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ network: 'regtest' }) })
    expect(await getWalletNetwork('wallet-a', connection.operatorUrl)).toBe(connection)
    expect(readVerifiedWalletNetwork).toHaveBeenCalledExactlyOnceWith('wallet-a', connection.operatorUrl)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('http://localhost:37770/v1/info', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
  it('never invents a network or provider for a wallet without a verified cache', async () => {
    vi.mocked(getNetwork).mockRejectedValue(new Error('Coordinator offline'))
    vi.mocked(readVerifiedWalletNetwork).mockReturnValue(undefined)
    await expect(getWalletNetwork('wallet-b', connection.operatorUrl)).rejects.toThrow('Coordinator offline')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects a changed live network even with a saved descriptor', async () => {
    vi.mocked(getNetwork).mockRejectedValue(new Error('Coordinator offline'))
    vi.mocked(readVerifiedWalletNetwork).mockReturnValue(connection)
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ network: 'bitcoin' }) })
    await expect(getWalletNetwork('wallet-a', connection.operatorUrl)).rejects.toThrow('different network')
  })
  it('does not turn a failed optional cache write into a failed wallet connection', () => {
    vi.mocked(rememberVerifiedWalletNetwork).mockImplementation(() => { throw new Error('Storage disabled') })
    expect(rememberWalletNetwork('wallet-a', connection)).toBe(false)
    expect(rememberVerifiedWalletNetwork).toHaveBeenCalledExactlyOnceWith('wallet-a', connection)
  })
})
