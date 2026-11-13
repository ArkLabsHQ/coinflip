import type { StashedV4Forfeit } from './v4ForfeitStash'

const DB_NAME = 'coinflip-recovery'
const STORE = 'games'
let connection: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'gameId' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }).catch((error) => { connection = undefined; throw error })
  }
  return connection
}

async function write(change: (store: IDBObjectStore) => void): Promise<void> {
  const db = await database()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Recovery data could not be saved'))
    change(tx.objectStore(STORE))
  })
}

/** Keep each funded game until its recovery is explicitly resolved. */
export async function loadV4Forfeits(): Promise<StashedV4Forfeit[]> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll()
    request.onsuccess = () => resolve(request.result as StashedV4Forfeit[])
    request.onerror = () => reject(request.error)
  })
}

export async function saveV4Forfeits(list: StashedV4Forfeit[]): Promise<void> {
  await write((store) => { store.clear(); for (const game of list) store.put(game) })
}

/** A keyed transaction keeps concurrent games from overwriting one another. */
export async function putV4Forfeit(game: StashedV4Forfeit): Promise<void> {
  await write((store) => store.put(game))
}

export async function deleteV4Forfeit(gameId: string): Promise<void> {
  await write((store) => store.delete(gameId))
}
