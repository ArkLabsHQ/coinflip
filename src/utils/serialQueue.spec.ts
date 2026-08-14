import { describe, it, expect } from 'vitest'
import { serialQueue } from './serialQueue'

/** A promise plus the handles to settle it from the test. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let queued `.then` callbacks fire before asserting. */
const tick = () => Promise.resolve()

describe('serialQueue', () => {
  it('does not start the second task until the first settles', async () => {
    const queue = serialQueue()
    const first = deferred<string>()
    let secondStarted = false

    const p1 = queue(() => first.promise)
    const p2 = queue(async () => {
      secondStarted = true
      return 'second'
    })

    await tick()
    expect(secondStarted).toBe(false) // still blocked behind the first

    first.resolve('first')
    expect(await p1).toBe('first')
    expect(await p2).toBe('second')
    expect(secondStarted).toBe(true)
  })

  it('gives each caller its OWN result — unlike singleFlight, nothing is shared', async () => {
    const queue = serialQueue()

    const p1 = queue(async () => 'txA')
    const p2 = queue(async () => 'txB')

    expect(await p1).toBe('txA')
    expect(await p2).toBe('txB')
  })

  it('runs tasks in the order they were queued', async () => {
    const queue = serialQueue()
    const order: number[] = []

    const p1 = queue(async () => void order.push(1))
    const p2 = queue(async () => void order.push(2))
    const p3 = queue(async () => void order.push(3))

    await Promise.all([p1, p2, p3])
    expect(order).toEqual([1, 2, 3])
  })

  it('keeps running after a task rejects, and the failing caller still sees the error', async () => {
    const queue = serialQueue()

    const p1 = queue(() => Promise.reject(new Error('round failed')))
    const p2 = queue(async () => 'survivor')

    await expect(p1).rejects.toThrow('round failed') // this caller gets its error
    expect(await p2).toBe('survivor') // the queue is not poisoned
  })

  it('does not start a task queued behind a rejection until that rejection settles', async () => {
    const queue = serialQueue()
    const first = deferred<string>()
    let secondStarted = false

    const p1 = queue(() => first.promise)
    const p2 = queue(async () => {
      secondStarted = true
      return 'second'
    })

    await tick()
    expect(secondStarted).toBe(false)

    first.reject(new Error('boom'))
    await expect(p1).rejects.toThrow('boom')
    expect(await p2).toBe('second')
  })

  it('each queue is independent — two queues do not block each other', async () => {
    const a = serialQueue()
    const b = serialQueue()
    const blocked = deferred<string>()
    let bRan = false

    const pa = a(() => blocked.promise)
    const pb = b(async () => {
      bRan = true
      return 'b'
    })

    expect(await pb).toBe('b') // queue B is unaffected by A being stuck
    expect(bRan).toBe(true)

    blocked.resolve('a')
    expect(await pa).toBe('a')
  })
})
