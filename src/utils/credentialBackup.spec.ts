import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  isCredentialBackupSupported,
  saveWalletToBrowser,
  importWalletFromBrowser,
} from './credentialBackup'

// Minimal stand-in for the browser's PasswordCredential constructor: records the
// init so we can assert on exactly what gets handed to navigator.credentials.store.
class FakePasswordCredential {
  id: string
  password: string
  name?: string
  constructor(init: { id: string; password: string; name?: string }) {
    this.id = init.id
    this.password = init.password
    this.name = init.name
  }
}

let storeMock: ReturnType<typeof vi.fn>
let getMock: ReturnType<typeof vi.fn>

// jsdom ships none of this surface, so we synthesize it. `secure`/`ctor`/`container`
// toggle each half of the support probe independently.
function installApi(opts: { secure?: boolean; ctor?: boolean; container?: boolean } = {}) {
  const { secure = true, ctor = true, container = true } = opts
  storeMock = vi.fn().mockResolvedValue(undefined)
  getMock = vi.fn().mockResolvedValue(null)
  vi.stubGlobal('PasswordCredential', ctor ? FakePasswordCredential : undefined)
  vi.stubGlobal('isSecureContext', secure)
  Object.defineProperty(navigator, 'credentials', {
    value: container ? { store: storeMock, get: getMock } : undefined,
    configurable: true,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true })
  vi.restoreAllMocks()
})

describe('isCredentialBackupSupported', () => {
  it('true when the constructor + credentials container + secure context are all present', () => {
    installApi()
    expect(isCredentialBackupSupported()).toBe(true)
  })

  it('false without PasswordCredential (non-Chromium browser)', () => {
    installApi({ ctor: false })
    expect(isCredentialBackupSupported()).toBe(false)
  })

  it('false without navigator.credentials', () => {
    installApi({ container: false })
    expect(isCredentialBackupSupported()).toBe(false)
  })

  it('false in an insecure (http) context', () => {
    installApi({ secure: false })
    expect(isCredentialBackupSupported()).toBe(false)
  })
})

describe('saveWalletToBrowser', () => {
  it('stores the secret keyed by the pubkey with the friendly name; resolves true', async () => {
    installApi()
    const secret = 'abandon abandon abandon … about'
    const pubkey = 'a'.repeat(64)

    const ok = await saveWalletToBrowser(secret, pubkey)

    expect(ok).toBe(true)
    expect(storeMock).toHaveBeenCalledTimes(1)
    const stored = storeMock.mock.calls[0][0]
    expect(stored.id).toBe(pubkey)
    expect(stored.password).toBe(secret)
    expect(stored.name).toBe('Coinflip Wallet')
  })

  it('no-ops to false when unsupported — never calls store', async () => {
    installApi({ ctor: false })
    expect(await saveWalletToBrowser('secret', 'id')).toBe(false)
    expect(storeMock).not.toHaveBeenCalled()
  })
})

describe('importWalletFromBrowser', () => {
  it('returns the stored secret from the retrieved credential', async () => {
    installApi()
    getMock.mockResolvedValue({ password: 'my recovery phrase' })

    expect(await importWalletFromBrowser()).toBe('my recovery phrase')
    // password: true asks for a PasswordCredential; optional mediation shows the
    // picker only when the browser can't hand one over silently.
    expect(getMock).toHaveBeenCalledWith({ password: true, mediation: 'optional' })
  })

  it('returns null when the picker is dismissed / nothing is stored (get resolves null)', async () => {
    installApi()
    getMock.mockResolvedValue(null)
    expect(await importWalletFromBrowser()).toBeNull()
  })

  it('returns null when unsupported — never calls get', async () => {
    installApi({ ctor: false })
    expect(await importWalletFromBrowser()).toBeNull()
    expect(getMock).not.toHaveBeenCalled()
  })
})
