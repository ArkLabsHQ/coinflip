import { describe, it, expect } from 'vitest'
import { upgradeEsploraUrl } from './esploraUrl'

/**
 * Regression: the denigiri regtest stack serves Esplora REST under the mempool
 * `/api` prefix. A browser that cached the bare `http://<host>:3000` would hit
 * the mempool web UI (HTML). upgradeEsploraUrl rewrites that known-bad shape
 * and leaves everything else alone.
 */
describe('upgradeEsploraUrl', () => {
  it('appends /api to a bare host:3000', () => {
    expect(upgradeEsploraUrl('http://localhost:3000')).toBe('http://localhost:3000/api')
  })

  it('handles a trailing slash without doubling it', () => {
    expect(upgradeEsploraUrl('http://localhost:3000/')).toBe('http://localhost:3000/api')
  })

  it('works for a LAN IP host (phone on the same wifi)', () => {
    expect(upgradeEsploraUrl('http://192.168.0.15:3000')).toBe('http://192.168.0.15:3000/api')
  })

  it('leaves an already-correct /api URL untouched', () => {
    expect(upgradeEsploraUrl('http://localhost:3000/api')).toBe('http://localhost:3000/api')
  })

  it('does not touch a non-esplora URL (e.g. the ark server on :7070)', () => {
    expect(upgradeEsploraUrl('http://localhost:7070')).toBe('http://localhost:7070')
  })

  it('does not touch a mutinynet / non-3000 esplora', () => {
    expect(upgradeEsploraUrl('https://mutinynet.arkade.sh')).toBe('https://mutinynet.arkade.sh')
  })

  it('passes null/empty through unchanged (absent cache key)', () => {
    expect(upgradeEsploraUrl(null)).toBeNull()
    expect(upgradeEsploraUrl('')).toBe('')
  })
})
