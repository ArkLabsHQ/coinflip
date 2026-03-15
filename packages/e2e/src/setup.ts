/**
 * Jest setup: polyfill browser APIs not available in Node.js.
 */

import { EventSource } from 'eventsource'

// The SDK's RestArkProvider.getEventStream() uses the global EventSource
;(globalThis as any).EventSource = EventSource
