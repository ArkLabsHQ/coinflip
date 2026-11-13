import { VtxoReservations, reservations } from 'arkade-coinflip-server/dist/vtxo-pool'
import { settleHeldInputs } from 'arkade-coinflip-server/dist/game-engine'

function walletHolds() {
  const held = new Set<string>()
  const released: string[] = []
  const wallet = {
    reserveVtxos(outpoints: readonly { txid: string; vout: number }[]) {
      const keys = outpoints.map((outpoint) => `${outpoint.txid}:${outpoint.vout}`)
      if (keys.some((key) => held.has(key))) throw new Error('SDK reservation conflict')
      keys.forEach((key) => held.add(key))
      let active = true
      return { outpoints, release() {
        if (!active) return
        active = false
        keys.forEach((key) => { held.delete(key); released.push(key) })
      } }
    },
  }
  return { held, released, wallet }
}

describe('game SDK holds', () => {
  it('updates only the hold delta and releases every hold on downgrade', () => {
    const { held, released, wallet } = walletHolds()
    const ledger = new VtxoReservations()
    ledger.bindWallet(wallet)
    ledger.reserve('game', ['aa:0', 'bb:1'], 5000)
    ledger.reserve('game', ['bb:1', 'cc:2'], 6000)
    expect([...held].sort()).toEqual(['bb:1', 'cc:2'])
    expect(released).toEqual(['aa:0'])
    ledger.reserve('game', [], 6000)
    expect(held.size).toBe(0)
    expect(ledger.totalLiability()).toBe(6000)
    ledger.reserve('settlement:1', ['dd:3'], 0)
    ledger.reserve('withdrawal:1', ['ee:4'], 0)
    expect(ledger.activeGames()).toBe(1)
    ledger.release('settlement:1')
    ledger.release('withdrawal:1')
    ledger.release('game')
    ledger.release('game')
    expect(released.sort()).toEqual(['aa:0', 'bb:1', 'cc:2', 'dd:3', 'ee:4'])
    expect(ledger.totalLiability()).toBe(0)
  })

  it('rolls back newly acquired holds while preserving the old reservation on conflict', () => {
    const { held, wallet } = walletHolds()
    const ledger = new VtxoReservations()
    ledger.bindWallet(wallet)
    ledger.reserve('game', ['aa:0'], 5000)
    const external = wallet.reserveVtxos([{ txid: 'cc', vout: 2 }])
    expect(() => ledger.reserve('game', ['aa:0', 'bb:1', 'cc:2'], 7000)).toThrow('SDK reservation conflict')
    expect([...held].sort()).toEqual(['aa:0', 'cc:2'])
    expect(ledger.snapshot()).toEqual([{ gameId: 'game', outpoints: ['aa:0'], liability: 5000 }])
    ledger.release('game')
    external.release()
    expect(held.size).toBe(0)
  })

  it('makes restored external maintenance holds visible without acquiring or releasing them twice', () => {
    const { held, released, wallet } = walletHolds(), ledger = new VtxoReservations()
    ledger.bindWallet(wallet)
    const owner = wallet.reserveVtxos([{ txid: 'aa', vout: 0 }])
    ledger.trackExternal('pool-maint:restored:proof', ['aa:0'])
    ledger.trackExternal('pool-maint:restored:proof', ['aa:0'])
    expect(ledger.reservedOutpoints()).toEqual(new Set(['aa:0']))
    expect(ledger.activeGames()).toBe(0)
    expect(() => ledger.reserve('game', ['aa:0'], 5000)).toThrow(/already reserved/)
    expect(() => ledger.trackExternal('pool-maint:restored:proof', ['bb:1'])).toThrow(/changed/)
    ledger.release('pool-maint:restored:proof')
    expect([...held]).toEqual(['aa:0'])
    expect(released).toEqual([])
    owner.release()
    expect(held.size).toBe(0)
  })

  it('keeps maintenance inputs held until settlement finishes, leaving game inputs held', async () => {
    const { held, wallet } = walletHolds()
    reservations.bindWallet(wallet)
    reservations.reserve('game', ['aa:0'], 5000)
    let finish!: (value: string) => void
    const complete = new Promise<string>((resolve) => { finish = resolve })
    const coin = { txid: 'bb', vout: 1, script: '5120', value: 6000 }
    const deps = { wallet: { ...wallet, settle: () => complete } }
    const running = settleHeldInputs(deps as never, { inputs: [coin], outputs: [] } as never, 'test')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect([...held].sort()).toEqual(['aa:0', 'bb:1'])
    expect(() => wallet.reserveVtxos([{ txid: 'bb', vout: 1 }])).toThrow('SDK reservation conflict')
    finish('settled')
    expect(await running).toBe('settled')
    expect([...held]).toEqual(['aa:0'])
    reservations.release('game')
    expect(held.size).toBe(0)
  })
})
