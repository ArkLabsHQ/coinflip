type EmulatorModule = typeof import('arkade-coinflip-server/dist/emulator.js')

describe('covenant service reconnect', () => {
  const previous = process.env.EMULATOR_URL
  let emulator: EmulatorModule
  let now: number
  beforeEach(() => {
    process.env.EMULATOR_URL = 'http://emulator.invalid'
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    emulator = require('arkade-coinflip-server/dist/emulator.js')
    now = 1_800_000_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    jest.restoreAllMocks()
    if (previous === undefined) delete process.env.EMULATOR_URL
    else process.env.EMULATOR_URL = previous
  })
  const info = () => new Response(JSON.stringify({ signerPubkey: `02${'11'.repeat(32)}`, version: 'fixture' }))

  it('recovers from a startup failure after a bounded retry delay without restarting the application', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(info())
    expect(await emulator.loadEmulatorConfig()).toBeUndefined()
    now += 4999
    expect(await emulator.loadEmulatorConfig()).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    now++
    expect((await emulator.loadEmulatorConfig())?.version).toBe('fixture')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('expires a successful health probe and recovers from a later service interruption', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(info())
      .mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValueOnce(info())
    expect(await emulator.loadEmulatorConfig()).toBeDefined()
    now += 29_999
    expect(await emulator.loadEmulatorConfig()).toBeDefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    now++
    expect(await emulator.loadEmulatorConfig()).toBeUndefined()
    now += 5000
    expect(await emulator.loadEmulatorConfig()).toBeDefined()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('collapses concurrent probes while preserving every caller result', async () => {
    let finish!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { finish = resolve })
    const fetch = jest.spyOn(globalThis, 'fetch').mockReturnValue(pending)
    const first = emulator.loadEmulatorConfig(), second = emulator.loadEmulatorConfig()
    expect(fetch).toHaveBeenCalledTimes(1)
    finish(info())
    const results = await Promise.all([first, second])
    expect(results[0]).toEqual(results[1])
    expect(results[0]?.signerPubkey).toHaveLength(32)
  })
})
