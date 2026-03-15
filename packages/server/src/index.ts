/**
 * Coinflip game coordination server.
 *
 * Provides:
 * - HTTP API for publishing/listing game events
 * - SSE for real-time game subscriptions
 * - Optional server-as-counterparty mode for instant P2P-style games
 */

import express from 'express'
import cors from 'cors'
import { v4 as uuidv4 } from 'uuid'
import {
  GameEvent,
  GameListing,
  gameFromEvents,
  isCreateEvent,
  isJoinEvent,
  isSetupStartedEvent,
  isSetupFinalizedEvent,
  isFinalizeEvent,
  isResolveEvent,
  GameStatus,
} from 'arkade-coinflip'

// -- In-memory game store --

interface GameStore {
  events: Map<string, GameEvent[]>
  subscribers: Map<string, Set<(event: GameEvent) => void>>
}

const store: GameStore = {
  events: new Map(),
  subscribers: new Map(),
}

function addEvent(gameId: string, event: GameEvent): void {
  if (!store.events.has(gameId)) {
    store.events.set(gameId, [])
  }
  store.events.get(gameId)!.push(event)

  // Notify subscribers
  const subs = store.subscribers.get(gameId)
  if (subs) {
    for (const handler of subs) {
      handler(event)
    }
  }
}

function subscribe(gameId: string, handler: (event: GameEvent) => void): () => void {
  if (!store.subscribers.has(gameId)) {
    store.subscribers.set(gameId, new Set())
  }
  store.subscribers.get(gameId)!.add(handler)
  return () => {
    store.subscribers.get(gameId)?.delete(handler)
  }
}

function isValidGameEvent(event: unknown): event is GameEvent {
  return (
    isCreateEvent(event) ||
    isJoinEvent(event) ||
    isSetupStartedEvent(event) ||
    isSetupFinalizedEvent(event) ||
    isFinalizeEvent(event) ||
    isResolveEvent(event)
  )
}

// -- Express app --

const app = express()
app.use(cors())
app.use(express.json())

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// List available games (created but not yet joined)
app.get('/api/games', (_req, res) => {
  const listings: GameListing[] = []

  for (const [gameId, events] of store.events.entries()) {
    try {
      const game = gameFromEvents(...events)
      if (game.status === GameStatus.Created && !game.player) {
        listings.push({
          gameId,
          creatorPubkey: events.find(isCreateEvent)?.creatorPubkey || '',
          betAmount: game.betAmount?.toString() || '0',
          createdAt: events.find(isCreateEvent)?.setupExpiration || 0,
        })
      }
    } catch {
      // Skip invalid games
    }
  }

  res.json(listings)
})

// Get game state (all events for a game)
app.get('/api/games/:gameId', (req, res) => {
  const events = store.events.get(req.params.gameId)
  if (!events || events.length === 0) {
    res.status(404).json({ error: 'Game not found' })
    return
  }

  try {
    const game = gameFromEvents(...events)
    res.json({ game, events })
  } catch (err) {
    res.status(500).json({ error: 'Failed to reconstruct game state' })
  }
})

// Publish a game event
app.post('/api/games/:gameId/events', (req, res) => {
  const { gameId } = req.params
  const event = req.body

  if (!event || typeof event !== 'object') {
    res.status(400).json({ error: 'Invalid event body' })
    return
  }

  // Ensure gameId matches
  event.gameId = gameId

  if (!isValidGameEvent(event)) {
    res.status(400).json({ error: 'Unrecognized event type' })
    return
  }

  // Validate event ordering
  const existingEvents = store.events.get(gameId) || []
  if (existingEvents.length === 0 && !isCreateEvent(event)) {
    res.status(400).json({ error: 'First event must be a create event' })
    return
  }

  if (existingEvents.length > 0 && isCreateEvent(event)) {
    res.status(400).json({ error: 'Game already created' })
    return
  }

  // Validate state machine transition
  try {
    gameFromEvents(...existingEvents, event)
  } catch (err) {
    res.status(400).json({ error: `Invalid event: ${(err as Error).message}` })
    return
  }

  addEvent(gameId, event)
  res.status(201).json({ ok: true })
})

// Create a new game (convenience: auto-generates gameId)
app.post('/api/games', (req, res) => {
  const event = req.body
  if (!isCreateEvent(event)) {
    res.status(400).json({ error: 'Body must be a create event' })
    return
  }

  const gameId = event.gameId || uuidv4()
  event.gameId = gameId

  addEvent(gameId, event)
  res.status(201).json({ gameId })
})

// SSE endpoint: subscribe to game events
app.get('/api/games/:gameId/subscribe', (req, res) => {
  const { gameId } = req.params

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  // Send existing events first
  const existingEvents = store.events.get(gameId) || []
  for (const event of existingEvents) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  // Subscribe to new events
  const unsubscribe = subscribe(gameId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  })

  // Keep-alive ping every 30s
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n')
  }, 30000)

  req.on('close', () => {
    unsubscribe()
    clearInterval(keepAlive)
  })
})

// -- Server startup --

const PORT = parseInt(process.env.PORT || '3001', 10)
const ARK_SERVER = process.env.ARK_SERVER || 'http://localhost:7070'

app.listen(PORT, () => {
  console.log(`Coinflip server listening on port ${PORT}`)
  console.log(`Ark server: ${ARK_SERVER}`)
})

export { app, store }
