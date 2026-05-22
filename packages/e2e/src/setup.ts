/**
 * Jest setup: polyfill browser APIs not available in Node.js.
 */

import { EventSource } from 'eventsource'
import WebSocket from 'ws'

// The SDK's RestArkProvider.getEventStream() uses the global EventSource
;(globalThis as any).EventSource = EventSource

// @arkade-os/boltz-swap's `BoltzSwapProvider.monitorSwap` uses
// `new globalThis.WebSocket(...)`. Node 22+ does have a built-in
// WebSocket, but it returns an empty-payload "WebSocket error" event
// against the Boltz server's WS upgrade flow in regtest. The `ws`
// library handles the handshake exchange more permissively, which the
// Boltz server actually does need — without this polyfill, reverse
// swaps fail at `waitAndClaim` immediately on connection.
;(globalThis as any).WebSocket = WebSocket
