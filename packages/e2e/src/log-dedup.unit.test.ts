/**
 * Pure unit test (no regtest) for the recovery/renewal log-noise suppressor.
 * Verifies it logs first/changed/heartbeat occurrences and resets on clear,
 * WITHOUT changing retry cadence (it only gates console output).
 */
import { makeLogDedup } from '../../server/src/log-dedup'

describe('makeLogDedup — recovery/renewal log-noise suppression', () => {
  it('logs the first occurrence, suppresses identical repeats', () => {
    const d = makeLogDedup(60_000, () => 1000)
    expect(d.shouldLog('g1', 'err A')).toBe(true)
    expect(d.shouldLog('g1', 'err A')).toBe(false)
    expect(d.shouldLog('g1', 'err A')).toBe(false)
  })

  it('logs again when the message changes', () => {
    const d = makeLogDedup(60_000, () => 1000)
    expect(d.shouldLog('g1', 'err A')).toBe(true)
    expect(d.shouldLog('g1', 'err B')).toBe(true)
  })

  it('re-logs an unchanged message only after the heartbeat interval', () => {
    let t = 1000
    const d = makeLogDedup(5000, () => t)
    expect(d.shouldLog('g1', 'err A')).toBe(true)
    t = 4000
    expect(d.shouldLog('g1', 'err A')).toBe(false) // within heartbeat -> suppressed
    t = 7000
    expect(d.shouldLog('g1', 'err A')).toBe(true) // heartbeat elapsed -> re-logged
  })

  it('clear() resets so the next occurrence logs fresh (success path)', () => {
    const d = makeLogDedup(60_000, () => 1000)
    expect(d.shouldLog('g1', 'err A')).toBe(true)
    d.clear('g1')
    expect(d.shouldLog('g1', 'err A')).toBe(true)
  })

  it('tracks keys (per-game) independently', () => {
    const d = makeLogDedup(60_000, () => 1000)
    expect(d.shouldLog('g1', 'err')).toBe(true)
    expect(d.shouldLog('g2', 'err')).toBe(true) // different key -> logged
    expect(d.shouldLog('g1', 'err')).toBe(false) // g1 still suppressed
  })
})
